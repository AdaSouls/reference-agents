import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorDigest } from "../src/anchor.js";
import { analyseAction } from "../src/analyse.js";
import { renderContext } from "../src/analysis.js";
import { splitConstitution } from "../src/constitution.js";
import { contextFacts, gatherContext, loadTreasuryPolicy, nclFor, withdrawalLovelace, type ActionContext, type TreasuryPolicy } from "../src/context.js";
import { buildFacts } from "../src/facts.js";
import { ingest, ingestOne } from "../src/ingest.js";
import { KoiosClient, proposalListSchema } from "../src/koios.js";
import type { Completer } from "../src/model.js";
import { ActionStore, ConstitutionStore } from "../src/store.js";

const fixtures = path.join(import.meta.dirname, "fixtures");
const file = (name: string) => readFile(path.join(fixtures, name));

/** Koios, recorded. Nothing leaves the process. */
const koiosFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const route: Record<string, string> = {
    "/api/v1/proposal_list": "proposal_list.json",
    "/api/v1/cli_protocol_params": "cli_protocol_params.json",
    "/api/v1/totals": "totals.json",
    "/api/v1/tip": "tip.json",
  };
  if (url.pathname === "/api/v1/proposal_voting_summary") {
    const id = url.searchParams.get("_proposal_id");
    if (id === "gov_action1fixturencl") return new Response(await file("ncl_voting_summary.json"));
    if (id === "gov_action1fixture000000000000000000000000000000000000000000002qq") return new Response(await file("proposal_voting_summary.json"));
    return new Response("[]");
  }
  const name = route[url.pathname];
  if (!name) throw new Error(`unexpected koios call in test: ${url}`);
  return new Response(await file(name), { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const anchorFetch = (async () => new Response(await file(path.join("anchors", "info-good.jsonld")))) as unknown as typeof fetch;

/** A policy whose period covers the fixture tip (epoch 666) and whose NCL Info action is in the fixtures. */
const policy: TreasuryPolicy = {
  netChangeLimits: [
    {
      lovelace: "100000000000000",
      ada: "100000000",
      epochs: { from: 600, to: 700 },
      actionKey: `${"9".repeat(64)}-0`,
      proposalId: "gov_action1fixturencl",
      anchorHash: "a".repeat(64),
      agreedWhen: "TREASURY-01a: Yes above 50% of active DRep voting stake",
      drepYesAbovePct: 50,
    },
  ],
};

describe("context: voting state, treasury, proposer history", () => {
  let dataDir: string;
  let store: ActionStore;
  const koios = new KoiosClient({ fetch: koiosFetch });
  const key = `${"2".repeat(64)}-0`; // the fixture TreasuryWithdrawals of 1,000,000 ADA

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "gov-ctx-"));
    store = new ActionStore(dataDir);
    await ingest(koios, store, { anchor: { fetch: anchorFetch } });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("the shipped treasury.yaml parses and names the 500M NCL for epochs 613–713", async () => {
    const shipped = await loadTreasuryPolicy(path.join(import.meta.dirname, "..", "context", "treasury.yaml"));
    const n = nclFor(shipped, 666)!;
    expect(n.ada).toBe("500000000");
    expect(n.epochs).toEqual({ from: 613, to: 713 });
    expect(n.actionKey).toMatch(/^a75645e0/);
    expect(nclFor(shipped, 600)).toBeUndefined();
  });

  it("ingest stores the whole proposal list for sums and history", async () => {
    const list = await store.readProposalList();
    expect(list).toHaveLength(7);
  });

  it("gathers a snapshot from Koios and derives facts the model never computes", async () => {
    const proposal = (await store.readOnchain(key))!;
    const ctx = await gatherContext(koios, proposal, policy, { now: () => new Date("2026-11-06T00:00:00Z") });
    expect(ctx.epoch).toBe(666);
    expect(ctx.ncl?.votingSummary?.drep_yes_pct).toBe(62.35);
    const all = proposalListSchema.parse(JSON.parse((await file("proposal_list.json")).toString("utf8")));
    const f = contextFacts(proposal, ctx, all);

    // Voting: DReps at 24.88% Yes against the 67% treasury threshold; SPOs don't vote on withdrawals.
    expect(f.voting.drep).toMatchObject({ yesPct: 24.88, noPct: 75.12, thresholdPct: 67, meetsThreshold: false, votesCast: { yes: 37, no: 42, abstain: 7 } });
    expect(f.voting.drep.yesPowerAda).toBe("1260493755.332955");
    expect(f.voting.spo.thresholdPct).toBeNull();
    expect(f.voting.committee.yesPct).toBe(28.57);
    expect(f.voting.passingNow).toBe(false);

    // Treasury: 100M NCL, 60M enacted inside 600–700 (the 7M at epoch 586 and the expired 3M don't count), 40M left; this action asks 1M; the other open withdrawal is 0 (none).
    expect(f.treasury).toMatchObject({
      balanceAda: "1396473702.511915",
      netChangeLimit: { ada: "100000000", drepYesPct: 62.35, agreed: true },
      enactedInPeriodAda: "60000000",
      remainingAda: "40000000",
      thisActionAda: "1000000",
      fitsRemaining: true,
      otherOpenWithdrawalsAda: "0",
    });

    // History: everything else from stake1u9fixture, newest first, with outcomes; this action excluded.
    expect(f.proposerHistory.actions.map((a) => [a.key.slice(0, 1), a.outcome])).toEqual([
      ["3", "open"],
      ["6", "enacted"],
      ["1", "open"],
      ["7", "expired"],
      ["4", "enacted"],
      ["5", "enacted"],
    ]);
    expect(f.proposerHistory.actions.find((a) => a.key.startsWith("6"))).toMatchObject({ withdrawalsAda: "60000000", titleClaimed: "Fixture enacted in the period" });

    const md = renderContext(buildFacts(proposal, (await store.readCheck(key))!, f));
    expect(md).toContain("| DReps | 24.88% | 75.12% | 37 / 42 / 7 | 67% | no |");
    expect(md).toContain("| Remaining under the limit | 40000000 ADA |");
    expect(md).toContain("Fixture enacted in the period");
  });

  it("reports unknown, never a guess, when there are no votes, no NCL or no params", async () => {
    const proposal = (await store.readOnchain(`${"3".repeat(64)}-1`))!; // ParameterChange: no votes recorded for it
    const ctx = await gatherContext(koios, proposal, { netChangeLimits: [] });
    const f = contextFacts(proposal, ctx, []);
    expect(f.voting.drep.yesPct).toBeNull();
    expect(f.voting.drep.thresholdPct).toBeNull(); // parameter group unknown
    expect(f.voting.passingNow).toBeNull();
    expect(f.voting.note).toContain("no votes");
    expect(f.treasury).toBeNull(); // not a withdrawal
    expect(f.proposerHistory.actions).toEqual([]);

    const tw = (await store.readOnchain(key))!;
    const noNcl = contextFacts(tw, { ...ctx, ncl: null }, []);
    expect(noNcl.treasury).toMatchObject({ netChangeLimit: null, enactedInPeriodAda: null, remainingAda: null, fitsRemaining: null });
    const notAgreed = contextFacts(tw, { ...ctx, ncl: { entry: policy.netChangeLimits[0], votingSummary: null } }, []);
    expect(notAgreed.treasury?.netChangeLimit?.agreed).toBeNull();
  });

  it("sums every withdrawal row of an action", async () => {
    expect(withdrawalLovelace({ withdrawal: [{ amount: "1" }, { amount: 2 }, { amount: null }] } as never)).toBe(3n);
    expect(withdrawalLovelace({ withdrawal: null } as never)).toBe(0n);
  });

  it("analyse takes the snapshot, stores it, cites it as a source, and reuses it offline", async () => {
    const constitutions = new ConstitutionStore(dataDir);
    const text = await file("constitution-excerpt.md");
    const ch = anchorDigest(text);
    await constitutions.save(ch, text, splitConstitution(text.toString("utf8")), {
      hash: ch, anchorUrl: "ipfs://x", actionKey: "k", proposalId: "g", enactedEpoch: 609, verifiedAt: "", bytes: 1, sections: 1, guardrails: 1,
    });
    const seen: string[] = [];
    const completer: Completer = {
      model: "fake",
      async complete(_system, user) {
        seen.push(user);
        return JSON.stringify({
          summary: "As of epoch 666 DReps are at 24.88% Yes against a 67% threshold.",
          whatChangesIfPassed: "1000000 ADA leaves the treasury.",
          constitutionSections: [{ id: "art-1-sec-1", relation: "governs", note: "n" }],
          tensions: [],
          budgetNotes: "40000000 ADA remain under the Net Change Limit; this action fits.",
          argumentsFor: ["a"],
          argumentsAgainst: ["b"],
          openQuestions: [],
          suggestedVote: { vote: "Abstain", confidence: 0.5, reason: "r" },
          conflictOfInterest: { applies: false, reason: "none" },
          figures: [
            { label: "requested", value: "1000000 ADA", source: "FACTS.withdrawals[0].ada" },
            { label: "DRep Yes", value: "24.88%", source: "FACTS.voting.drep.yesPct" },
            { label: "DRep threshold", value: "67%", source: "FACTS.voting.drep.thresholdPct" },
            { label: "remaining", value: "40000000 ADA", source: "FACTS.treasury.remainingAda" },
            { label: "epoch", value: "epoch 666", source: "FACTS.voting.asOfEpoch" },
          ],
        });
      },
    };
    const base = { system: "s", completer, conflictOfInterestPolicy: "", provenance: { agent: "alma:main:agent:test", almaVersion: "a".repeat(64) } };
    const r = await analyseAction(key, store, constitutions, { ...base, context: { koios, treasuryPolicy: policy } });
    expect(r.facts.voting?.drep.yesPct).toBe(24.88);
    expect(r.facts.treasury?.remainingAda).toBe("40000000");
    expect(seen[0]).toContain('"remainingAda": "40000000"');
    expect(r.record.sources.map((s) => s.ref)).toEqual([
      "/proposal_list",
      expect.stringMatching(/^context\.json@/),
      "/proposal_list (stored)",
      expect.anything(),
      ch,
    ]);
    const stored = await store.readContext<ActionContext>(key);
    expect(stored?.epoch).toBe(666);
    const md = await readFile(r.files.markdown, "utf8");
    expect(md).toContain("## Where the vote stands (epoch 666");
    expect(md).toContain("## Treasury (epoch 666)");

    // Offline: no Koios, the stored snapshot is used.
    const again = await analyseAction(key, store, constitutions, { ...base, context: { treasuryPolicy: policy } });
    expect(again.facts.voting?.asOfEpoch).toBe(666);

    // A figure that cites a context path but gets it wrong is rejected like any other.
    const wrong: Completer = { model: "fake", async complete() { return (await completer.complete("", "", undefined, [])).replace('"value":"24.88%"', '"value":"30%"'); } };
    await expect(analyseAction(key, store, constitutions, { ...base, completer: wrong, maxAttempts: 1, context: { treasuryPolicy: policy } })).rejects.toThrow(/does not match FACTS.voting.drep.yesPct/);
  });

  it("without a snapshot the facts simply lack the three sections", async () => {
    const proposal = (await store.readOnchain(key))!;
    const facts = buildFacts(proposal, (await store.readCheck(key))!);
    expect(facts.voting).toBeUndefined();
    expect(renderContext(facts)).toBe("");
    void ingestOne;
  });
});
