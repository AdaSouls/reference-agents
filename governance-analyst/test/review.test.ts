import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorDigest } from "../src/anchor.js";
import { analyseAction } from "../src/analyse.js";
import { splitConstitution } from "../src/constitution.js";
import { ingestOne } from "../src/ingest.js";
import { proposalListSchema } from "../src/koios.js";
import type { Completer } from "../src/model.js";
import { decidedByFromEscalation, reviewAction } from "../src/review.js";
import { generateKeyFile, loadSigner, verifyRecord } from "../src/signing.js";
import { ActionStore, ConstitutionStore } from "../src/store.js";

const fixtures = path.join(import.meta.dirname, "fixtures");

describe("gov review", () => {
  let dataDir: string;
  let key: string;
  let actions: ActionStore;

  const answer = {
    summary: "Fixture summary.",
    whatChangesIfPassed: "Nothing real.",
    constitutionSections: [{ id: "art-1-sec-1", relation: "governs", note: "n" }],
    tensions: [],
    budgetNotes: "Deposit 100000 ADA.",
    argumentsFor: ["a"],
    argumentsAgainst: ["b"],
    openQuestions: [],
    suggestedVote: { vote: "Yes", confidence: 0.6, reason: "r" },
    conflictOfInterest: { applies: false, reason: "none" },
    figures: [{ label: "deposit", value: "100000 ADA", source: "FACTS.deposit.ada" }],
  };
  const completer: Completer = { model: "fake", async complete() { return JSON.stringify(answer); } };

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "gov-rev-"));
    actions = new ActionStore(dataDir);
    const p = proposalListSchema.parse(JSON.parse(await readFile(path.join(fixtures, "proposal_list.json"), "utf8")))[0];
    const f = (async () => new Response(await readFile(path.join(fixtures, "anchors", "info-good.jsonld")))) as unknown as typeof fetch;
    await ingestOne(p, actions, { anchor: { fetch: f } });
    const constitutions = new ConstitutionStore(dataDir);
    const text = await readFile(path.join(fixtures, "constitution-excerpt.md"));
    await constitutions.save("c".repeat(64), text, splitConstitution(text.toString("utf8")), {
      hash: "c".repeat(64), anchorUrl: "ipfs://x", actionKey: "k", proposalId: "g", enactedEpoch: 609, verifiedAt: "", bytes: 1, sections: 1, guardrails: 1,
    });
    key = `${"1".repeat(64)}-0`;
    await analyseAction(key, actions, constitutions, { system: "s", completer, conflictOfInterestPolicy: "" });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reads who decides from escalation.yaml", async () => {
    const d = await decidedByFromEscalation(path.join(import.meta.dirname, "..", "escalation.yaml"));
    expect(d.person).toBe("Matías Falcone");
  });

  it("records the decision, writes the final rationale, and hashes it like cardano-cli", async () => {
    const r = await reviewAction(key, actions, {
      vote: "No",
      reason: "The proposer's document does not say who is accountable.",
      decidedBy: { person: "Matías Falcone", role: "DRep" },
      now: () => new Date("2026-11-04T02:00:00Z"),
    });
    expect(r.decision).toMatchObject({ vote: "No", suggestedVote: "Yes", agreesWithAnalysis: false, decidedBy: { person: "Matías Falcone" } });
    const rationaleBytes = await readFile(r.files.rationale);
    expect(anchorDigest(rationaleBytes)).toBe(r.decision.rationale.anchorHash);
    const rationale = JSON.parse(rationaleBytes.toString("utf8")) as { body: { comment: string } };
    expect(rationale.body.comment).toContain("VOTE: No.");
    expect(rationale.body.comment).toContain("Why we vote this way: The proposer's document");
    expect(rationale.body.comment).toContain("the AI analysis suggested Yes");
    expect(rationale.body.comment).not.toContain("draft");
    const decision = JSON.parse(await readFile(r.files.decision, "utf8"));
    expect(decision.analysisDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.files.decisionSignature).toBeUndefined();
  });

  it("signs analysis and decision with the analysis key; anyone verifies with the public key", async () => {
    const keyFile = path.join(dataDir, "analysis.key");
    const { kid, publicKeyHex } = await generateKeyFile(keyFile);
    const signer = await loadSigner(keyFile);
    expect(signer.kid).toBe(kid);
    const r = await reviewAction(key, actions, { vote: "Yes", reason: "ok", decidedBy: { person: "Matías Falcone", role: "DRep" }, signer });
    const pub = Uint8Array.from(publicKeyHex.match(/../g)!, (h) => parseInt(h, 16));
    const dec = JSON.parse(await readFile(r.files.decisionSignature!, "utf8"));
    const ana = JSON.parse(await readFile(r.files.analysisSignature!, "utf8"));
    expect(dec.payload).toMatchObject({ t: "alma-governance-decision/draft-1", iss: "adasouls.io", kid, vote: "Yes", rationaleHash: r.decision.rationale.anchorHash, decidedBy: "Matías Falcone" });
    expect(ana.payload).toMatchObject({ t: "alma-governance-analysis/draft-1", kid, analysisDigest: r.decision.analysisDigest });
    expect(await verifyRecord(dec, pub)).toBe(true);
    expect(await verifyRecord(ana, pub)).toBe(true);
    // Tampering with one byte of the payload breaks it.
    const tampered = { ...dec, payload: { ...dec.payload, vote: "No" } };
    expect(await verifyRecord(tampered, pub)).toBe(false);
    // The key file is private to the owner.
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(keyFile));
    expect(mode & 0o077).toBe(0);
  });
});
