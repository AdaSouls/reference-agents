import { describe, expect, it } from "vitest";
import { judge, loadCases, runCase, type EvalCase } from "../src/eval.js";
import type { Completer } from "../src/model.js";

/** A model that answers whatever the test wants; the runner and the judge are what is under test here. */
const answer = (over: Record<string, unknown>) =>
  JSON.stringify({
    summary: "Fixture.",
    whatChangesIfPassed: "Nothing.",
    constitutionSections: [{ id: "art-1-sec-1", relation: "governs", note: "n" }],
    tensions: [],
    budgetNotes: "The Net Change Limit leaves 500000 ADA; this asks 1000000 ADA.",
    argumentsFor: ["a"],
    argumentsAgainst: ["b"],
    openQuestions: ["The anchor bytes do not match the on-chain hash."],
    suggestedVote: { vote: "No", confidence: 0.7, reason: "r" },
    conflictOfInterest: { applies: false, reason: "none" },
    figures: [
      { label: "requested", value: "1000000 ADA", source: "FACTS.withdrawals[0].ada" },
      { label: "DRep Yes", value: "24.88%", source: "FACTS.voting.drep.yesPct" },
      { label: "remaining", value: "500000 ADA", source: "FACTS.treasury.remainingAda" },
    ],
    ...over,
  });
const completer = (over: Record<string, unknown> = {}): Completer => ({ model: "fake", async complete() { return answer(over); } });

describe("gov eval", () => {
  it("every shipped case parses and names what it expects", async () => {
    const cases = await loadCases();
    expect(cases.map((c) => c.name)).toEqual(["info-action-verified", "withdrawal-anchor-mismatch", "withdrawal-exceeds-ncl"]);
    for (const c of cases) expect(Object.keys(c.expect).length).toBeGreaterThan(0);
  });

  it("builds the fixture world for a case offline and judges the analysis against it", async () => {
    const cases = await loadCases();
    const ncl = cases.find((c) => c.name === "withdrawal-exceeds-ncl")!;
    const r = await runCase(ncl, completer());
    expect(r.facts.treasury?.remainingAda).toBe("500000");
    expect(r.facts.treasury?.fitsRemaining).toBe(false);
    expect(r.facts.anchor.status).toBe("verified");

    const mm = cases.find((c) => c.name === "withdrawal-anchor-mismatch")!;
    const m = await runCase(mm, completer({ budgetNotes: "Nothing to add.", figures: [{ label: "requested", value: "1000000 ADA", source: "FACTS.withdrawals[0].ada" }, { label: "DRep Yes", value: "24.88%", source: "FACTS.voting.drep.yesPct" }] }));
    expect(m.facts.anchor.status).toBe("mismatch");
    expect(judge(mm, m)).toEqual([]);
    expect(judge(ncl, r)).toEqual([]);

    const yes = await runCase(ncl, completer({ suggestedVote: { vote: "Yes", confidence: 0.9, reason: "r" }, budgetNotes: "Fine.", figures: [{ label: "requested", value: "1000000 ADA", source: "FACTS.withdrawals[0].ada" }] }));
    expect(judge(ncl, yes)).toEqual(["vote Yes not in No/Abstain", 'budgetNotes does not mention "Net Change Limit"', "no figure sourced from FACTS.treasury.remainingAda"]);
  });

  it("the gates still apply inside an eval: an unsourced figure is a rejected analysis, not a judged one", async () => {
    const c: EvalCase = { name: "x", description: "d", action: { index: 0, anchor: "info-good.jsonld" }, constitution: "constitution-excerpt.md", expect: {} };
    const bad = completer({ budgetNotes: "It costs 123456 ADA.", figures: [{ label: "x", value: "123456 ADA", source: "FACTS.withdrawals[0].ada" }] });
    await expect(runCase(c, bad)).rejects.toThrow(/analysis rejected/);
  });
});
