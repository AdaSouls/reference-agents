import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, PaymentNotReportedError, type AdaSoulsClient, type EconomicAction } from "@adasouls/sdk";
import { buildGuardedTreasury, payVendorFromWallet } from "../src/guarded-treasury.js";

const OWNER = "0x2222222222222222222222222222222222222222";

/**
 * A mocked adasouls-api, enough to restart the agent against: it replays
 * an Idempotency-Key like the real one, keeps a self-paid action
 * authorized until its payment is reported, and can drop reports.
 */
function fakeApi() {
  const byKey = new Map<string, EconomicAction>();
  let reportsDown = 0;
  const action = (): EconomicAction =>
    ({
      id: `eco_${byKey.size + 1}`,
      principalId: "alma:main:organization:acme",
      agentId: "agent_treasury",
      intent: { capability: "pay", amount: "500", asset: "USDC" },
      capability: "pay",
      authority: { delegationId: "del_1", policySnapshot: [] },
      status: "authorized",
      needsReconciliation: false,
      createdAt: new Date().toISOString(),
      executionPlan: { mode: "self", chain: "base-sepolia", from: "0xfrom", to: OWNER, amount: "500", asset: "USDC" },
    }) as EconomicAction;
  const find = (id: string) => [...byKey.values()].find((a) => a.id === id)!;
  const post = vi.fn(async (path: string, body: { txHash?: string }, headers?: Record<string, string>) => {
    if (path === "/economic-actions") {
      const key = headers?.["Idempotency-Key"] ?? String(Math.random());
      if (!byKey.has(key)) byKey.set(key, action());
      return byKey.get(key);
    }
    const id = decodeURIComponent(path.split("/")[2]);
    if (reportsDown > 0) {
      reportsDown--;
      throw new Error("network down");
    }
    const a = find(id);
    if (a.status !== "authorized") throw new Error(`409: ${id} is ${a.status}`);
    Object.assign(a, { status: "confirmed", execution: { mode: "self", txHash: body.txHash } });
    return a;
  });
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/authority")) return { activeDelegations: [{ id: "del_1", scope: { capabilities: ["pay"] } }] };
    return find(decodeURIComponent(path.split("/")[2]));
  });
  return { agent: new Agent({ get, post } as unknown as AdaSoulsClient, "agent_treasury"), failNextReports: (n: number) => (reportsDown = n) };
}

describe("Treasury Agent paying from its own wallet", () => {
  let paymentsDir: string;
  beforeEach(async () => (paymentsDir = await mkdtemp(join(tmpdir(), "treasury-payments-"))));
  afterEach(() => rm(paymentsDir, { recursive: true, force: true }));

  it("sends exactly what was authorized, to the vendor's owner, and records it on disk", async () => {
    const { agent } = fakeApi();
    const send = vi.fn().mockResolvedValue("0xabc");
    const paid = await payVendorFromWallet(buildGuardedTreasury(agent, { send, paymentsDir }), "alma:main:agent:vendor", "2026-10-27");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: OWNER, amount: "500", asset: "USDC" });
    expect(paid).toMatchObject({ txHash: "0xabc", action: { status: "confirmed" } });
    expect(await readdir(paymentsDir)).toEqual(["eco_1.json"]);
  });

  it("a restart after sending but before reporting: rerunning the same run pays once", async () => {
    const api = fakeApi();
    const send = vi.fn().mockResolvedValue("0xabc");
    api.failNextReports(1);
    await expect(payVendorFromWallet(buildGuardedTreasury(api.agent, { send, paymentsDir }), "alma:main:agent:vendor", "2026-10-27")).rejects.toBeInstanceOf(PaymentNotReportedError);

    // A new process: only the payments directory survived.
    const paid = await payVendorFromWallet(buildGuardedTreasury(api.agent, { send, paymentsDir }), "alma:main:agent:vendor", "2026-10-27");
    expect(paid).toMatchObject({ txHash: "0xabc", action: { id: "eco_1", status: "confirmed" } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a new run is a new payment", async () => {
    const { agent } = fakeApi();
    const send = vi.fn().mockResolvedValueOnce("0xabc").mockResolvedValueOnce("0xdef");
    const wallet = buildGuardedTreasury(agent, { send, paymentsDir });
    await payVendorFromWallet(wallet, "alma:main:agent:vendor", "2026-10-27");
    await payVendorFromWallet(wallet, "alma:main:agent:vendor", "2026-10-28");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
