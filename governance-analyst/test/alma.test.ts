import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDelegation, createIdentity, LocalSigner, revokeDelegation } from "@adasouls/alma-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorDigest } from "../src/anchor.js";
import { AlmaRefusal, guard, loadAgentSigner, loadAlma, selfIssuer } from "../src/alma.js";

const shipped = path.join(import.meta.dirname, "..", "alma.yaml");
const ORG = "alma:main:org:adasouls";

/** A deployed agent: the committed alma.yaml plus what `alma connect` writes to .alma/. */
async function deploy(dir: string, opts: { manifest?: string; capabilities?: string[]; expiresAt?: string; revoked?: boolean; noIdentity?: boolean } = {}) {
  await writeFile(path.join(dir, "alma.yaml"), opts.manifest ?? (await readFile(shipped, "utf8")));
  if (opts.noIdentity) return undefined;
  const identity = createIdentity({ subjectType: "agent", displayName: "governance-analyst", principal: ORG });
  let delegation = createDelegation({ issuer: ORG, subject: identity.id, scope: { capabilities: opts.capabilities ?? ["analyze", "attest"] }, expiresAt: opts.expiresAt });
  if (opts.revoked) delegation = revokeDelegation(delegation, ORG, "test");
  const almaDir = path.join(dir, ".alma");
  await mkdir(almaDir, { recursive: true });
  await writeFile(path.join(almaDir, "identity.json"), JSON.stringify(identity));
  await writeFile(path.join(almaDir, "delegations.json"), JSON.stringify([delegation]));
  const signer = await LocalSigner.generate();
  await writeFile(path.join(almaDir, "issuer.key"), await signer.exportPkcs8(), { mode: 0o600 });
  return { identity, signer };
}

const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AlmaRefusal);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("the agent's ALMA", () => {
  let dir: string;
  const net = { network: "cardano:mainnet" };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gov-alma-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the shipped rules, the identity, the active delegation and the key", async () => {
    const d = await deploy(dir);
    const alma = loadAlma(dir);
    expect(alma.name).toBe("governance-analyst");
    expect(alma.capabilities).toEqual(["analyze", "attest"]);
    expect(alma.governance).toEqual({ networks: ["cardano:mainnet"], humanDecides: ["vote"], publish: "after-decision" });
    expect(alma.almaVersion).toBe(anchorDigest(await readFile(path.join(dir, "alma.yaml"))));
    expect(alma.identity?.id).toBe(d!.identity.id);
    expect(alma.delegation?.issuer).toBe(ORG);
    expect((await loadAgentSigner(alma)).kid).toBe(d!.signer.kid);
    expect(selfIssuer(alma.identity!.id)).toBe(`self:${alma.identity!.id}`);
    for (const c of ["ingest", "constitution", "analyse", "review", "publish", "anchor"] as const) guard(alma, c, net);
  });

  it("changes almaVersion when one byte of the rules changes", async () => {
    await deploy(dir, { noIdentity: true });
    const before = loadAlma(dir).almaVersion;
    await writeFile(path.join(dir, "alma.yaml"), (await readFile(shipped, "utf8")) + "\n");
    expect(loadAlma(dir).almaVersion).not.toBe(before);
  });

  it("reads public data without an identity, and refuses to sign without one", async () => {
    await deploy(dir, { noIdentity: true });
    const alma = loadAlma(dir);
    guard(alma, "ingest", net);
    guard(alma, "constitution", net);
    expect(refusal(() => guard(alma, "analyse", net))).toContain("alma connect");
    expect(refusal(() => guard(alma, "review", net))).toContain("no ALMA identity");
    await expect(loadAgentSigner(alma)).rejects.toBeInstanceOf(AlmaRefusal);
  });

  it("refuses with an expired, revoked or narrower delegation", async () => {
    await deploy(dir, { expiresAt: "2020-01-01T00:00:00Z" });
    expect(refusal(() => guard(loadAlma(dir), "analyse", net))).toContain("no active delegation");
    await deploy(dir, { revoked: true });
    expect(refusal(() => guard(loadAlma(dir), "analyse", net))).toContain("no active delegation");
    await deploy(dir, { capabilities: ["analyze"] });
    const alma = loadAlma(dir);
    guard(alma, "analyse", net);
    expect(refusal(() => guard(alma, "review", net))).toContain("did not delegate `attest`");
  });

  it("refuses networks and action types outside alma.yaml", async () => {
    const yaml = (await readFile(shipped, "utf8")).replace("  humanDecides:", "  actionTypes: [InfoAction]\n  humanDecides:");
    await deploy(dir, { manifest: yaml });
    const alma = loadAlma(dir);
    expect(refusal(() => guard(alma, "ingest", { network: "cardano:preprod" }))).toContain("not in alma.yaml governance.networks");
    guard(alma, "analyse", { ...net, actionType: "InfoAction" });
    expect(refusal(() => guard(alma, "analyse", { ...net, actionType: "TreasuryWithdrawals" }))).toContain("governance.actionTypes");
  });

  it("refuses a vote decision unless a person decides, and undecided publishing after-decision", async () => {
    await deploy(dir, { manifest: (await readFile(shipped, "utf8")).replace("  humanDecides:\n    - vote\n", "") });
    const alma = loadAlma(dir);
    expect(refusal(() => guard(alma, "review", net))).toContain("humanDecides");
    guard(alma, "publish", net);
    expect(refusal(() => guard(alma, "publish", { ...net, includeUndecided: true }))).toContain("after the decision");
  });

  it("refuses to run at all when alma.yaml grants `vote`, is missing, or has no governance section", async () => {
    await deploy(dir, { manifest: (await readFile(shipped, "utf8")).replace("  - attest\n", "  - attest\n  - vote\n") });
    expect(refusal(() => guard(loadAlma(dir), "ingest", net))).toContain("never votes");
    await rm(path.join(dir, "alma.yaml"));
    expect(refusal(() => loadAlma(dir))).toContain("no alma.yaml");
    await writeFile(path.join(dir, "alma.yaml"), "kind: Agent\nversion: alma/v1\nmetadata:\n  name: x\nidentity:\n  type: agent\ncapabilities: [analyze]\n");
    expect(refusal(() => loadAlma(dir))).toContain("governance");
    await writeFile(path.join(dir, "alma.yaml"), (await readFile(shipped, "utf8")).replace("publish: after-decision", "publish: whenever"));
    expect(refusal(() => loadAlma(dir))).toContain("governance");
  });
});
