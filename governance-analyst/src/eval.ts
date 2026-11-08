#!/usr/bin/env -S npx tsx
/**
 * gov eval: pins the analyst's judgement with cases (STANDARD.md rule 5).
 *
 *   npm run eval -- --record   runs the real model on every case and stores its answers in evals/recorded/
 *   npm run eval -- --replay   replays the recordings offline: the gates and the expectations must still hold
 *   npm run eval               = --replay
 *
 * A case is a fixture action (from test/fixtures) plus what we expect of a
 * good analysis of it: an acceptable vote, sections it must cite, words
 * its budget notes must contain, FACTS paths its figures must source.
 * Recordings carry the prompt version; a changed prompt makes every replay
 * stale, so the behaviour is re-recorded and re-judged on purpose, never
 * by accident. `npm run check` runs the replay: a recording that no longer
 * meets its case fails CI.
 */
import { config } from "dotenv";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { analyseAction, type AnalyseResult } from "./analyse.js";
import { AnalysisRejected, PROMPT_VERSION, loadSystemPrompt } from "./analysis.js";
import { anchorDigest } from "./anchor.js";
import { splitConstitution } from "./constitution.js";
import { contextFacts, gatherContext, type TreasuryPolicy, treasuryPolicySchema } from "./context.js";
import { ingestOne } from "./ingest.js";
import { KoiosClient, proposalListSchema, type Proposal } from "./koios.js";
import { anthropicCompleter, type Completer, type Turn } from "./model.js";
import { ActionStore, ConstitutionStore } from "./store.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const projectDir = path.resolve(here, "..");
const fixtures = path.join(projectDir, "test", "fixtures");
const casesDir = path.join(projectDir, "evals", "cases");
const recordedDir = path.join(projectDir, "evals", "recorded");

export const caseSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    action: z.object({
      /** Index into test/fixtures/proposal_list.json. */
      index: z.number().int().min(0),
      /** Anchor file under test/fixtures/anchors served for its URL; omit for "unavailable". */
      anchor: z.string().optional(),
    }),
    constitution: z.string().default("constitution-excerpt.md"),
    /** Koios context from fixtures, with an optional treasury policy override; omit for an analysis without a snapshot. */
    context: z
      .object({ treasuryPolicy: treasuryPolicySchema.optional(), votingSummary: z.string().optional() })
      .optional(),
    expect: z
      .object({
        vote: z.array(z.enum(["Yes", "No", "Abstain"])).min(1).optional(),
        maxConfidence: z.number().min(0).max(1).optional(),
        citesSections: z.array(z.string()).optional(),
        budgetNotesMention: z.array(z.string()).optional(),
        openQuestionsMention: z.array(z.string()).optional(),
        figuresFrom: z.array(z.string()).optional(),
        conflictOfInterest: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type EvalCase = z.infer<typeof caseSchema>;

const recordingSchema = z.object({
  case: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  recordedAt: z.string(),
  /** Every model answer in order: the retry loop may have asked more than once. */
  responses: z.array(z.string()).min(1),
});
export type Recording = z.infer<typeof recordingSchema>;

/** Serves the recorded Koios and anchor fixtures; nothing leaves the process. */
function fixtureFetch(c: EvalCase): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const file = async (name: string) => new Response(await readFile(path.join(fixtures, name)));
    if (url.hostname === "anchors.example") return c.action.anchor ? file(path.join("anchors", c.action.anchor)) : new Response("not found", { status: 404 });
    const route: Record<string, string> = {
      "/api/v1/proposal_list": "proposal_list.json",
      "/api/v1/cli_protocol_params": "cli_protocol_params.json",
      "/api/v1/totals": "totals.json",
      "/api/v1/tip": "tip.json",
    };
    if (url.pathname === "/api/v1/proposal_voting_summary") {
      const id = url.searchParams.get("_proposal_id") ?? "";
      if (id === "gov_action1fixturencl") return file("ncl_voting_summary.json");
      return c.context?.votingSummary ? file(c.context.votingSummary) : new Response("[]");
    }
    const name = route[url.pathname];
    if (!name) throw new Error(`eval fixture fetch: no fixture for ${url}`);
    return file(name);
  }) as typeof fetch;
}

const defaultPolicy: TreasuryPolicy = {
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

/** A completer that answers from a recording and records what the real one said. */
function replayCompleter(rec: Recording): Completer {
  let i = 0;
  return {
    model: rec.model,
    async complete() {
      const r = rec.responses[i++];
      if (r === undefined) throw new Error(`recording for ${rec.case} has ${rec.responses.length} answers; the analysis asked for more`);
      return r;
    },
  };
}

function recordingCompleter(inner: Completer, sink: string[]): Completer {
  return {
    model: inner.model,
    async complete(system: string, user: string, maxTokens?: number, history?: Turn[]) {
      const r = await inner.complete(system, user, maxTokens, history);
      sink.push(r);
      return r;
    },
  };
}

/** Builds the fixture world for a case in a temp dir and runs the analysis there. */
export async function runCase(c: EvalCase, completer: Completer, log: (l: string) => void = () => {}): Promise<AnalyseResult> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `gov-eval-${c.name}-`));
  try {
    const fetch = fixtureFetch(c);
    const store = new ActionStore(dataDir);
    const list = proposalListSchema.parse(JSON.parse(await readFile(path.join(fixtures, "proposal_list.json"), "utf8")));
    const proposal: Proposal | undefined = list[c.action.index];
    if (!proposal) throw new Error(`${c.name}: no fixture proposal at index ${c.action.index}`);
    await store.saveProposalList(list);
    await ingestOne(proposal, store, { anchor: { fetch }, now: () => new Date("2026-11-03T00:00:00Z") });
    const key = `${proposal.proposal_tx_hash}-${proposal.proposal_index}`;

    const constitutions = new ConstitutionStore(dataDir);
    const text = await readFile(path.join(fixtures, c.constitution));
    const hash = anchorDigest(text);
    await constitutions.save(hash, text, splitConstitution(text.toString("utf8")), {
      hash, anchorUrl: "fixture", actionKey: "fixture", proposalId: "fixture", enactedEpoch: 609, verifiedAt: "2026-11-03T00:00:00Z", bytes: text.length, sections: 0, guardrails: 0,
    });

    const koios = new KoiosClient({ fetch });
    const policy = c.context?.treasuryPolicy ?? defaultPolicy;
    if (c.context) {
      const ctx = await gatherContext(koios, proposal, policy, { now: () => new Date("2026-11-06T00:00:00Z") });
      await store.saveContext(key, ctx);
      void contextFacts;
    }
    return await analyseAction(key, store, constitutions, {
      system: await loadSystemPrompt(path.join(projectDir, "prompts")),
      completer,
      conflictOfInterestPolicy: "AdaSouls, ALDEA World, SOULS stake pool",
      provenance: { agent: "alma:main:agent:governance-analyst-eval", almaVersion: "0".repeat(64) },
      context: c.context ? { treasuryPolicy: policy } : undefined,
      now: () => new Date("2026-11-06T00:00:00Z"),
      log,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** The expectations, as a list of failures (empty = the case holds). */
export function judge(c: EvalCase, r: AnalyseResult): string[] {
  const a = r.record.analysis;
  const out: string[] = [];
  const e = c.expect;
  if (e.vote && !e.vote.includes(a.suggestedVote.vote)) out.push(`vote ${a.suggestedVote.vote} not in ${e.vote.join("/")}`);
  if (e.maxConfidence != null && a.suggestedVote.confidence > e.maxConfidence) out.push(`confidence ${a.suggestedVote.confidence} above ${e.maxConfidence}`);
  for (const id of e.citesSections ?? []) if (!a.constitutionSections.some((s) => s.id === id)) out.push(`does not cite ${id}`);
  const lc = (s: string) => s.toLowerCase();
  for (const w of e.budgetNotesMention ?? []) if (!lc(a.budgetNotes).includes(lc(w))) out.push(`budgetNotes does not mention "${w}"`);
  for (const w of e.openQuestionsMention ?? []) if (!a.openQuestions.some((q) => lc(q).includes(lc(w)))) out.push(`openQuestions do not mention "${w}"`);
  for (const p of e.figuresFrom ?? []) if (!a.figures.some((f) => f.source === p)) out.push(`no figure sourced from ${p}`);
  if (e.conflictOfInterest != null && a.conflictOfInterest.applies !== e.conflictOfInterest) out.push(`conflictOfInterest.applies is ${a.conflictOfInterest.applies}`);
  return out;
}

export async function loadCases(): Promise<EvalCase[]> {
  const files = (await readdir(casesDir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => caseSchema.parse(JSON.parse(await readFile(path.join(casesDir, f), "utf8")))));
}

async function main() {
  config({ path: path.join(projectDir, ".env"), quiet: true });
  const args = process.argv.slice(2);
  const record = args.includes("--record");
  const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const cases = (await loadCases()).filter((c) => !only || c.name === only);
  if (!cases.length) {
    console.error("no eval cases");
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  for (const c of cases) {
    const recFile = path.join(recordedDir, `${c.name}.json`);
    try {
      let result: AnalyseResult;
      if (record) {
        const model = process.env.ANALYSIS_MODEL ?? "claude-sonnet-4-5";
        const sink: string[] = [];
        try {
          result = await runCase(c, recordingCompleter(anthropicCompleter(model), sink));
        } catch (err) {
          // Keep what the model said even when the gates rejected every attempt: the recording shows it.
          if (err instanceof AnalysisRejected && sink.length) {
            await mkdir(recordedDir, { recursive: true });
            await writeFile(recFile, JSON.stringify({ case: c.name, promptVersion: PROMPT_VERSION, model, recordedAt: new Date().toISOString(), responses: sink, rejected: err.message } satisfies Recording & { rejected: string }, null, 2) + "\n");
          }
          throw err;
        }
        await mkdir(recordedDir, { recursive: true });
        await writeFile(recFile, JSON.stringify({ case: c.name, promptVersion: PROMPT_VERSION, model, recordedAt: new Date().toISOString(), responses: sink } satisfies Recording, null, 2) + "\n");
      } else {
        let rec: Recording;
        try {
          rec = recordingSchema.parse(JSON.parse(await readFile(recFile, "utf8")));
        } catch {
          throw new Error(`no recording at evals/recorded/${c.name}.json — run: npm run eval -- --record --only=${c.name}`);
        }
        if (rec.promptVersion !== PROMPT_VERSION) throw new Error(`recording is for ${rec.promptVersion}, code runs ${PROMPT_VERSION} — re-record`);
        result = await runCase(c, replayCompleter(rec));
      }
      const problems = judge(c, result);
      if (problems.length) {
        failed++;
        console.log(`FAIL  ${c.name}: ${problems.join("; ")}`);
      } else {
        console.log(`ok    ${c.name}: ${result.record.analysis.suggestedVote.vote} (${result.record.analysis.suggestedVote.confidence}), ${result.record.analysis.figures.length} figures, ${result.record.attempts.count} attempt(s)`);
      }
    } catch (err) {
      failed++;
      console.log(`FAIL  ${c.name}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  console.log(`\n${cases.length - failed} of ${cases.length} cases hold (${record ? "recorded" : "replayed"}, prompt ${PROMPT_VERSION})`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
