import { describe, expect, it } from "vitest";
import { buildTreasuryAgent, describeAgent, putIdleTreasuryToWork } from "../src/treasury-agent.js";

/**
 * Real HTTP against a real, locally-running adasouls-api -- proves the
 * headline scenario ("put 500 USDC of idle treasury to work") actually
 * works end to end through nothing but @adasouls/sdk, per
 * reference-agents/REPOSITORY.md's "zero internal shortcuts". Fixture
 * (org + self/counterparty policies + delegation + API key) comes from
 * `npm run create-treasury-agent-test-fixture` in adasouls-api -- the
 * service-layer equivalent of what src/setup.ts does over real Auth0
 * REST, see that script's header comment for why.
 */
const apiKey = process.env.ADASOULS_TEST_API_KEY;
const agentId = process.env.ADASOULS_TEST_AGENT_ID;
const baseUrl = process.env.ADASOULS_API_URL;
// A registered vendor with real (fixture) history -- the counterparty
// policy is checked against what the API computes, not what we claim.
const vendorId = process.env.ADASOULS_TEST_VENDOR_ID;

describe.skipIf(!apiKey || !agentId || !baseUrl || !vendorId)("Treasury Agent", () => {
  it("puts 500 USDC of idle treasury to work: authorized under the self/counterparty policies set up for it", async () => {
    const agent = buildTreasuryAgent({ apiKey: apiKey!, agentId: agentId!, baseUrl });

    const result = await putIdleTreasuryToWork(agent, vendorId!);

    expect(result.amount).toBe("500");
    expect(result.asset).toBe("USDC");
    expect(["authorized", "executing", "confirmed"]).toContain(result.status);
  });

  it("describeAgent() returns identity, authority, reputation, and history entirely from the public SDK", async () => {
    const agent = buildTreasuryAgent({ apiKey: apiKey!, agentId: agentId!, baseUrl });
    await putIdleTreasuryToWork(agent, vendorId!);

    const summary = await describeAgent(agent);

    expect(summary.identity.id).toBe(agentId);
    expect(summary.authority.activeDelegations.length).toBeGreaterThan(0);
    expect(summary.reputation.agentId).toBe(agentId);
    expect(summary.history.items.length).toBeGreaterThan(0);
  });

  it("rejects a payment to a counterparty that doesn't meet the counterparty policy", async () => {
    const agent = buildTreasuryAgent({ apiKey: apiKey!, agentId: agentId!, baseUrl });

    // An unregistered vendor has no history the API can vouch for, so the
    // fixture's minCompletedTransactions: 1 rule rejects it -- whatever the
    // caller might claim about it.
    await expect(
      agent.execute({
        capability: "pay",
        amount: "10",
        asset: "USDC",
        to: "agent_untrusted_vendor",
        counterparty: { id: "agent_untrusted_vendor" },
      })
    ).rejects.toMatchObject({ reasons: expect.arrayContaining([expect.stringContaining("completed transactions")]) });
  });
});
