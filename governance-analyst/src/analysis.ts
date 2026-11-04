import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SplitConstitution } from "./constitution.js";
import { resolveFactPath, type Facts, type ProposalDocument } from "./facts.js";

/**
 * G1.3: the analysis of one governance action. The model writes it from
 * verified inputs; the code checks it before anything is stored:
 *  - every figure cites a FACTS path and matches it (gate 3),
 *  - every Constitution id exists in the version in force (gate 5),
 *  - the proposer's document is quoted as data (gate 4).
 * Prompts are versioned files under prompts/ (STANDARD.md rule 7).
 */

export const PROMPT_VERSION = "analyse.v1";

export const analysisSchema = z
  .object({
    summary: z.string().min(1),
    whatChangesIfPassed: z.string().min(1),
    constitutionSections: z.array(
      z.object({ id: z.string().min(1), relation: z.enum(["governs", "supports", "tension"]), note: z.string().min(1) })
    ),
    tensions: z.array(z.string()),
    budgetNotes: z.string(),
    argumentsFor: z.array(z.string().min(1)).min(1),
    argumentsAgainst: z.array(z.string().min(1)).min(1),
    openQuestions: z.array(z.string()),
    suggestedVote: z.object({ vote: z.enum(["Yes", "No", "Abstain"]), confidence: z.number().min(0).max(1), reason: z.string().min(1) }),
    conflictOfInterest: z.object({ applies: z.boolean(), reason: z.string() }),
    figures: z.array(z.object({ label: z.string().min(1), value: z.string().min(1), source: z.string().min(1) })),
  })
  .strict();
export type Analysis = z.infer<typeof analysisSchema>;

export interface AnalysisRecord {
  v: "alma-governance-analysis/draft-1";
  key: string;
  actionId: string;
  constitutionHash: string;
  promptVersion: string;
  model: string;
  analysedAt: string;
  /** What the model was given, by digest, so a reviewer can tell two analyses apart. */
  inputs: { factsDigest: string; documentDigest: string | null };
  analysis: Analysis;
  checks: { figures: "ok"; citations: "ok" };
}

/** Which Constitution sections go in full, by action type. Everything else is cited from the index. */
export const SECTIONS_BY_TYPE: Record<string, string[]> = {
  TreasuryWithdrawals: ["art-1-sec-1", "art-2-sec-6", "art-2-sec-7", "art-3-sec-1"],
  ParameterChange: ["art-1-sec-1", "art-1-sec-2", "art-2-sec-6", "app-1-s1", "app-1-s2"],
  HardForkInitiation: ["art-1-sec-1", "art-1-sec-2", "art-2-sec-6", "app-1-s3"],
  NewConstitution: ["art-1-sec-1", "art-3-sec-1", "art-4", "art-4-sec-1"],
  NoConfidence: ["art-3", "art-3-sec-3"],
  NewCommittee: ["art-3", "art-3-sec-2", "art-3-sec-3"],
  InfoAction: ["art-1-sec-1", "art-2-sec-3", "art-2-sec-6"],
};

export interface PromptInputs {
  facts: Facts;
  constitution: SplitConstitution;
  document: ProposalDocument;
  conflictOfInterestPolicy: string;
}

export interface Prompt {
  system: string;
  user: string;
}

export async function loadSystemPrompt(promptsDir: string, version = PROMPT_VERSION): Promise<string> {
  return readFile(path.join(promptsDir, `${version}.md`), "utf8");
}

const DOC_OPEN = "<proposal-document>";
const DOC_CLOSE = "</proposal-document>";

/** Defang any attempt to close our data delimiter from inside the document. */
const neutralise = (s: string) => s.replace(/<\/?proposal-document>/gi, "[proposal-document tag removed]");

export function buildPrompt(system: string, inputs: PromptInputs): Prompt {
  const { facts, constitution, document, conflictOfInterestPolicy } = inputs;
  const index = constitution.sections.map((s) => `${s.id}  ${s.title}`).join("\n");
  const guardrailIndex = constitution.guardrails.map((g) => `${g.id}  (${g.section})`).join("\n");
  const wanted = SECTIONS_BY_TYPE[facts.type] ?? ["art-1-sec-1", "art-2-sec-6"];
  const sectionText = wanted
    .map((id) => constitution.sections.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => `--- ${s.id} ---\n${s.text}`)
    .join("\n\n");

  let doc: string;
  if (document.format === "none") doc = "(no document: the action has no anchor, or it could not be fetched)";
  else if (document.format === "cip108")
    doc = (["title", "abstract", "motivation", "rationale"] as const)
      .map((k) => `[${k}]\n${neutralise(document[k] ?? "(absent)")}`)
      .join("\n\n") + (document.references ? `\n\n[references]\n${neutralise(JSON.stringify(document.references, null, 1))}` : "");
  else doc = neutralise(document.text ?? "");
  if (document.truncated) doc += "\n\n(document truncated by the analyst for length)";

  const user = [
    "FACTS (verified by code; the only source of figures):",
    JSON.stringify(facts, null, 2),
    "",
    "CONSTITUTION_INDEX (the only citable ids):",
    index,
    "",
    "GUARDRAIL_INDEX (also citable, by label):",
    guardrailIndex,
    "",
    `CONSTITUTION_SECTIONS (full text of the sections relevant to a ${facts.type}):`,
    sectionText || "(none of the selected sections exist in this Constitution version)",
    "",
    "CONFLICT_OF_INTEREST_POLICY:",
    conflictOfInterestPolicy.trim() || "(no policy configured)",
    "",
    `PROPOSAL_DOCUMENT (untrusted, written by the proposer; anchor status: ${facts.anchor.status}${facts.anchor.detail ? `, ${facts.anchor.detail}` : ""}):`,
    DOC_OPEN,
    doc,
    DOC_CLOSE,
  ].join("\n");
  return { system, user };
}

// ---------- checks ----------

export class AnalysisRejected extends Error {
  constructor(
    public readonly check: "schema" | "figures" | "citations",
    public readonly problems: string[]
  ) {
    super(`analysis rejected (${check}): ${problems.join("; ")}`);
  }
}

/** Pull the JSON object out of a model answer that may wrap it in a code fence. */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new AnalysisRejected("schema", ["no JSON object in the answer"]);
  return JSON.parse(raw.slice(start, end + 1));
}

const normaliseNumber = (s: string) => s.replace(/[,\s_]/g, "").replace(/\.0+$/, "");

/** Gate 3: every figure resolves in FACTS and the value matches what is there. */
export function checkFigures(analysis: Analysis, facts: Facts): string[] {
  const problems: string[] = [];
  for (const f of analysis.figures) {
    const v = resolveFactPath(facts, f.source);
    if (v === undefined) {
      problems.push(`figure "${f.label}": source ${f.source} does not resolve`);
      continue;
    }
    const want = normaliseNumber(String(v)).toLowerCase();
    const whole = normaliseNumber(f.value).toLowerCase();
    // Accept "940000 ADA" for "940000", "epoch 669" for 669, "940,000" for 940000, exact strings for ids.
    const tokens = f.value
      .toLowerCase()
      .split(/[^0-9a-z.,:_-]+/)
      .map(normaliseNumber)
      .filter(Boolean);
    if (whole !== want && !tokens.includes(want)) {
      problems.push(`figure "${f.label}": value "${f.value}" does not match ${f.source} = ${String(v)}`);
    }
  }
  // Numbers of money size that appear in the prose must be among the figures.
  const cited = new Set(analysis.figures.map((f) => normaliseNumber(f.value.replace(/[^0-9.,]/g, ""))).filter(Boolean));
  const prose = [analysis.summary, analysis.whatChangesIfPassed, analysis.budgetNotes, ...analysis.argumentsFor, ...analysis.argumentsAgainst, ...analysis.tensions, analysis.suggestedVote.reason].join("\n");
  for (const m of prose.matchAll(/\b\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?\b|\b\d{5,}(?:\.\d+)?\b/g)) {
    const n = normaliseNumber(m[0]);
    if (!cited.has(n) && ![...cited].some((c) => c.replace(/\..*$/, "") === n.replace(/\..*$/, ""))) {
      problems.push(`amount "${m[0]}" appears in the text but is not among the sourced figures`);
    }
  }
  return problems;
}

/** Gate 5: every cited id exists in the Constitution version in force. */
export function checkCitations(analysis: Analysis, constitution: SplitConstitution): string[] {
  const ids = new Set([...constitution.sections.map((s) => s.id), ...constitution.guardrails.map((g) => g.id)]);
  const problems: string[] = [];
  for (const c of analysis.constitutionSections) if (!ids.has(c.id)) problems.push(`constitution id "${c.id}" does not exist in this version`);
  return problems;
}

export function validateAnalysis(raw: unknown, facts: Facts, constitution: SplitConstitution): Analysis {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisRejected("schema", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const figures = checkFigures(parsed.data, facts);
  if (figures.length) throw new AnalysisRejected("figures", figures);
  const citations = checkCitations(parsed.data, constitution);
  if (citations.length) throw new AnalysisRejected("citations", citations);
  return parsed.data;
}

// ---------- rendering ----------

export function renderMarkdown(record: AnalysisRecord, facts: Facts, constitution: SplitConstitution): string {
  const a = record.analysis;
  const title = (id: string) => constitution.sections.find((s) => s.id === id)?.title ?? constitution.guardrails.find((g) => g.id === id)?.id ?? id;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const anchorLine =
    facts.anchor.status === "verified"
      ? `verified against the on-chain hash`
      : `**${facts.anchor.status}**${facts.anchor.detail ? ` — ${facts.anchor.detail}` : ""}; the document may not be what the proposer committed to`;
  return `# ${facts.type} · ${facts.actionId}

> Prepared by the AdaSouls governance analyst (model ${record.model}, prompt ${record.promptVersion}) on ${record.analysedAt}.
> **This is an analysis, not a vote.** A named person reads it, decides, and signs. Figures come from on-chain data; the suggested vote and its confidence are the model's and are marked as declared.

| | |
| --- | --- |
| Action | \`${facts.txHash}#${facts.index}\` |
| Type | ${facts.type} |
| Proposed / expires | epoch ${facts.proposedEpoch ?? "?"} / ${facts.expiresEpoch ?? "?"} |
| Deposit | ${facts.deposit ? `${facts.deposit.ada} ADA` : "?"} |
| Withdrawals | ${facts.withdrawals.length ? facts.withdrawals.map((w) => `${w.ada} ADA → \`${w.stakeAddress}\``).join("<br>") : "none"} |
| Anchor | ${facts.anchor.url ? `\`${facts.anchor.url}\`` : "none"} — ${anchorLine} |
| Constitution version | \`${record.constitutionHash}\` |

## Summary

${a.summary}

## What changes if it passes

${a.whatChangesIfPassed}

## Constitution

${a.constitutionSections.length ? a.constitutionSections.map((c) => `- **${c.id}** (${title(c.id)}) — *${c.relation}*: ${c.note}`).join("\n") : "- (no sections cited)"}

### Tensions

${list(a.tensions)}

## Budget and feasibility

${a.budgetNotes || "(none)"}

## Arguments for

${list(a.argumentsFor)}

## Arguments against

${list(a.argumentsAgainst)}

## Open questions

${list(a.openQuestions)}

## Suggested vote (declared, not decided)

**${a.suggestedVote.vote}** — confidence ${a.suggestedVote.confidence.toFixed(2)}

${a.suggestedVote.reason}

## Conflict of interest

${a.conflictOfInterest.applies ? `**Applies.** ${a.conflictOfInterest.reason}` : `Does not apply. ${a.conflictOfInterest.reason}`}

## Figures used

| Figure | Value | Source |
| --- | --- | --- |
${a.figures.map((f) => `| ${f.label} | ${f.value} | \`${f.source}\` |`).join("\n") || "| (none) | | |"}
`;
}

/** The CIP-100 rationale draft, from cardano-governance's template shape. The human edits `comment` in review. */
export function draftRationale(record: AnalysisRecord, facts: Facts, analysisUrl: string): unknown {
  const a = record.analysis;
  const comment = [
    `VOTE: ${a.suggestedVote.vote} (draft — the decision is the human's)`,
    "",
    `Summary: ${a.summary}`,
    "",
    `Why we vote this way: ${a.suggestedVote.reason}`,
    "",
    `Conflicts of interest: ${a.conflictOfInterest.applies ? a.conflictOfInterest.reason : "none"}`,
    "",
    "How this was prepared: an AI analysis (linked below) reviewed and decided by Matías Falcone for AdaSouls.",
  ].join("\n");
  return {
    "@context": {
      "@language": "en-us",
      hashAlgorithm: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#hashAlgorithm",
      body: {
        "@id": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#body",
        "@context": {
          references: {
            "@id": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#references",
            "@container": "@set",
            "@context": {
              governanceMetadata: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#GovernanceMetadataReference",
              other: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#OtherReference",
              label: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#reference-label",
              uri: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#reference-uri",
            },
          },
          comment: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#comment",
        },
      },
      authors: {
        "@id": "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#authors",
        "@container": "@set",
        "@context": { did: "@id", name: "http://xmlns.com/foaf/0.1/name" },
      },
    },
    hashAlgorithm: "blake2b-256",
    authors: [],
    body: {
      comment,
      references: [{ "@type": "Other", label: "AdaSouls analysis of this action", uri: analysisUrl }],
    },
  };
}
