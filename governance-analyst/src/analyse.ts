import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { anchorDigest } from "./anchor.js";
import { buildPrompt, draftRationale, parseModelJson, renderMarkdown, validateAnalysis, type AnalysisRecord } from "./analysis.js";
import type { SplitConstitution } from "./constitution.js";
import { buildFacts, describeProposalDocument, type Facts } from "./facts.js";
import type { Completer } from "./model.js";
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
  /** URL the rationale will point at; `{key}` is replaced. */
  analysisUrlTemplate?: string;
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
  const split = hash ? await constitutions.readSections<SplitConstitution>(hash) : undefined;
  if (!hash || !split) throw new Error("no Constitution stored; run `gov constitution` first");

  const facts = buildFacts(onchain, check);
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await readFile(path.join(actions.dir(key), "anchor.bin")));
  } catch {
    bytes = undefined;
  }
  const document = describeProposalDocument(bytes);
  const prompt = buildPrompt(options.system, { facts, constitution: split, document, conflictOfInterestPolicy: options.conflictOfInterestPolicy });
  log(`analysing ${key} (${facts.type}) with ${options.completer.model}; anchor ${facts.anchor.status}; document ${document.format}`);

  const answer = await options.completer.complete(prompt.system, prompt.user);
  const analysis = validateAnalysis(parseModelJson(answer), facts, split, document);

  const record: AnalysisRecord = {
    v: "alma-governance-analysis/draft-1",
    key,
    actionId: facts.actionId,
    constitutionHash: hash,
    promptVersion: "analyse.v1",
    model: options.completer.model,
    analysedAt: (options.now ?? (() => new Date()))().toISOString(),
    inputs: {
      factsDigest: anchorDigest(new TextEncoder().encode(JSON.stringify(facts))),
      documentDigest: bytes ? anchorDigest(bytes) : null,
    },
    analysis,
    checks: { figures: "ok", citations: "ok" },
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
