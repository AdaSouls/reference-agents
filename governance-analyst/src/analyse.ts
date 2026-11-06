import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { anchorDigest } from "./anchor.js";
import { AnalysisRejected, PROMPT_VERSION, buildPrompt, draftRationale, parseModelJson, renderMarkdown, validateAnalysis, type Analysis, type AnalysisRecord } from "./analysis.js";
import { splitConstitution } from "./constitution.js";
import { contextFacts, gatherContext, type ActionContext, type TreasuryPolicy } from "./context.js";
import { buildFacts, describeProposalDocument, type Facts } from "./facts.js";
import type { KoiosClient } from "./koios.js";
import type { Completer, Turn } from "./model.js";
import type { ActionStore, ConstitutionStore } from "./store.js";

/**
 * `gov analyse <tx>-<ix>`: facts from the store, Constitution in force,
 * one model call, checks, then analysis.json / analysis.md /
 * rationale.draft.jsonld next to the action's data. Nothing here signs,
 * publishes or decides.
 */

export interface AnalyseOptions {
  system: string;
  completer: Completer;
  conflictOfInterestPolicy: string;
  /**
   * Model answers allowed before giving up (default 3). A rejected answer
   * is sent back with the exact problems; the checks are never relaxed.
   */
  maxAttempts?: number;
  /** Who is producing this and under which rules (from the agent's ALMA). */
  provenance: { agent: string | null; almaVersion: string };
  /** URL the rationale will point at; `{key}` is replaced. */
  analysisUrlTemplate?: string;
  /**
   * Voting state, treasury and proposer history. With `koios`, a fresh
   * snapshot is taken and stored as context.json; without it the stored
   * snapshot is used (`--offline`), or none if there is none.
   */
  context?: { koios?: KoiosClient; treasuryPolicy: TreasuryPolicy };
  now?: () => Date;
  log?: (line: string) => void;
}

export interface AnalyseResult {
  record: AnalysisRecord;
  facts: Facts;
  files: { json: string; markdown: string; rationale: string };
}

export async function analyseAction(
  key: string,
  actions: ActionStore,
  constitutions: ConstitutionStore,
  options: AnalyseOptions
): Promise<AnalyseResult> {
  const log = options.log ?? (() => {});
  const onchain = await actions.readOnchain(key);
  const check = await actions.readCheck(key);
  if (!onchain || !check) throw new Error(`action ${key} is not ingested; run \`gov ingest\` first`);
  const hash = await constitutions.currentHash();
  // Always split from the stored, verified text: the citable index can never lag behind the splitter.
  const text = hash ? await constitutions.readText(hash) : undefined;
  const split = text && anchorDigest(new TextEncoder().encode(text)) === hash ? splitConstitution(text) : undefined;
  if (!hash || !split) throw new Error("no verified Constitution stored; run `gov constitution` first");

  let context: ActionContext | undefined;
  if (options.context?.koios) {
    context = await gatherContext(options.context.koios, onchain, options.context.treasuryPolicy, { now: options.now, log });
    await actions.saveContext(key, context);
  } else {
    context = await actions.readContext<ActionContext>(key);
    if (context) log(`using stored context from ${context.fetchedAt} (epoch ${context.epoch})`);
    else log("no context: voting state, treasury and proposer history unknown");
  }
  const allProposals = (await actions.readProposalList()) ?? [];
  if (context && allProposals.length === 0) log("no stored proposal list: run `gov ingest` for treasury sums and proposer history");
  const facts = buildFacts(onchain, check, context ? contextFacts(onchain, context, allProposals) : undefined);
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await readFile(path.join(actions.dir(key), "anchor.bin")));
  } catch {
    bytes = undefined;
  }
  const document = describeProposalDocument(bytes);
  const prompt = buildPrompt(options.system, { facts, constitution: split, document, conflictOfInterestPolicy: options.conflictOfInterestPolicy });
  log(`analysing ${key} (${facts.type}) with ${options.completer.model}; anchor ${facts.anchor.status}; document ${document.format}`);

  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const history: Turn[] = [];
  const rejected: { check: string; problems: string[] }[] = [];
  let analysis: Analysis | undefined;
  for (let attempt = 1; attempt <= maxAttempts && !analysis; attempt++) {
    const answer = await options.completer.complete(prompt.system, prompt.user, undefined, history);
    try {
      analysis = validateAnalysis(parseModelJson(answer), facts, split, document);
    } catch (err) {
      const r =
        err instanceof AnalysisRejected
          ? err
          : new AnalysisRejected("schema", [`answer is not valid JSON: ${(err as Error).message}`]);
      rejected.push({ check: r.check, problems: r.problems });
      log(`attempt ${attempt}/${maxAttempts} rejected (${r.check}): ${r.problems.length} problem(s)`);
      if (attempt === maxAttempts) throw new AnalysisRejected(r.check, r.problems);
      history.push(
        { role: "assistant", content: answer },
        {
          role: "user",
          content: [
            `Your answer was rejected by the ${r.check} check. Problems:`,
            ...r.problems.map((p) => `- ${p}`),
            "",
            "Answer again with the complete JSON object, the exact keys of the schema, and nothing else. Do not drop content to pass the check: fix the source of each figure (FACTS path or DOCUMENT.<field>) or the id of each citation.",
          ].join("\n"),
        }
      );
    }
  }
  if (!analysis) throw new AnalysisRejected("schema", ["no answer"]);

  const record: AnalysisRecord = {
    v: "alma-governance-analysis/draft-1",
    key,
    actionId: facts.actionId,
    agent: options.provenance.agent,
    almaVersion: options.provenance.almaVersion,
    sources: [
      { name: "koios", ref: "/proposal_list", digest: await sha256Hex(new TextEncoder().encode(JSON.stringify(onchain))) },
      ...(context ? [{ name: "koios" as const, ref: `context.json@${context.fetchedAt}`, digest: await sha256Hex(new TextEncoder().encode(JSON.stringify(context))) }] : []),
      ...(context && allProposals.length ? [{ name: "koios" as const, ref: "/proposal_list (stored)", digest: await sha256Hex(new TextEncoder().encode(JSON.stringify(allProposals))) }] : []),
      { name: "anchor", ref: facts.anchor.url ?? "(none)", digest: bytes ? anchorDigest(bytes) : null },
      { name: "constitution", ref: hash, digest: hash },
    ],
    constitutionHash: hash,
    promptVersion: PROMPT_VERSION,
    model: options.completer.model,
    analysedAt: (options.now ?? (() => new Date()))().toISOString(),
    inputs: {
      factsDigest: anchorDigest(new TextEncoder().encode(JSON.stringify(facts))),
      documentDigest: bytes ? anchorDigest(bytes) : null,
    },
    analysis,
    checks: { figures: "ok", citations: "ok" },
    attempts: { count: rejected.length + 1, rejected },
  };

  const dir = actions.dir(key);
  const files = { json: path.join(dir, "analysis.json"), markdown: path.join(dir, "analysis.md"), rationale: path.join(dir, "rationale.draft.jsonld") };
  const url = (options.analysisUrlTemplate ?? "https://github.com/AdaSouls/cardano-governance/blob/main/votes/{key}/analysis.md").replace("{key}", key);
  await writeFile(files.json, JSON.stringify(record, null, 2) + "\n");
  await writeFile(files.markdown, renderMarkdown(record, facts, split));
  await writeFile(files.rationale, JSON.stringify(draftRationale(record, facts, url), null, 2) + "\n");
  log(`suggested ${analysis.suggestedVote.vote} (confidence ${analysis.suggestedVote.confidence}); ${analysis.openQuestions.length} open questions; written to ${dir}`);
  return { record, facts, files };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
