import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SplitConstitution } from "./constitution.js";
import { resolveFactPath, type Facts, type ProposalDocument } from "./facts.js";

/** Fields of the proposer's document a figure may be quoted from. */
export const DOCUMENT_FIELDS = ["title", "abstract", "motivation", "rationale", "references"] as const;
export type DocumentField = (typeof DOCUMENT_FIELDS)[number];

export function documentFieldText(document: ProposalDocument, field: DocumentField): string | undefined {
  if (document.format !== "cip108") return field === "abstract" ? document.text : undefined;
  const v = document[field];
  return typeof v === "string" ? v : v == null ? undefined : JSON.stringify(v);
}

/**
 * G1.3: the analysis of one governance action. The model writes it from
 * verified inputs; the code checks it before anything is stored:
 *  - every figure cites a FACTS path and matches it (gate 3),
 *  - every Constitution id exists in the version in force (gate 5),
 *  - the proposer's document is quoted as data (gate 4).
 * Prompts are versioned files under prompts/ (STANDARD.md rule 7).
 */

export const PROMPT_VERSION = "analyse.v3";

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

export interface AnalysisSource {
  name: "koios" | "anchor" | "constitution";
  /** Where it came from: an endpoint, the anchor URL, the Constitution's action key. */
  ref: string;
  /** blake2b-256 (anchor, constitution) or sha-256 (koios record) of the bytes used, hex. */
  digest: string | null;
}

export interface AnalysisRecord {
  v: "alma-governance-analysis/draft-1";
  key: string;
  actionId: string;
  /** The ALMA id of the agent that produced it (null only in tests without an identity). */
  agent: string | null;
  /** blake2b-256 of the alma.yaml it ran under. */
  almaVersion: string;
  /** Every input, with the digest of exactly the bytes used (STANDARD.md rule 4). */
  sources: AnalysisSource[];
  constitutionHash: string;
  promptVersion: string;
  model: string;
  analysedAt: string;
  /** What the model was given, by digest, so a reviewer can tell two analyses apart. */
  inputs: { factsDigest: string; documentDigest: string | null };
  analysis: Analysis;
  checks: { figures: "ok"; citations: "ok" };
  /** How many model answers it took, and why earlier ones were rejected. Nothing is hidden. */
  attempts: { count: number; rejected: { check: string; problems: string[] }[] };
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

/** `FACTS.*` = verified on chain by code; `DOCUMENT.<field>` = stated by the proposer, unverified. */
export function figureKind(source: string): "verified" | "claimed" | "unknown" {
  if (/^FACTS[.[]/.test(source)) return "verified";
  if (new RegExp(`^DOCUMENT\\.(${DOCUMENT_FIELDS.join("|")})$`).test(source.trim())) return "claimed";
  return "unknown";
}

/**
 * Gate 3: every figure has a source and matches it. A FACTS figure must
 * equal the value at that path. A DOCUMENT figure must appear, as a
 * number, in that field of the proposer's document: the analysis may quote
 * what the proposer wrote, and the reader sees it is the proposer's claim.
 */
export function checkFigures(analysis: Analysis, facts: Facts, document?: ProposalDocument): string[] {
  const problems: string[] = [];
  for (const f of analysis.figures) {
    const kind = figureKind(f.source);
    if (kind === "claimed") {
      const field = f.source.trim().slice("DOCUMENT.".length) as DocumentField;
      const text = document ? documentFieldText(document, field) : undefined;
      if (text === undefined) {
        problems.push(`figure "${f.label}": ${f.source} is not in the proposal document`);
        continue;
      }
      const numbers = new Set(Array.from(text.matchAll(/\d[\d,._\s]*\d|\d/g), (m) => normaliseNumber(m[0])));
      const wanted = Array.from(f.value.matchAll(/\d[\d,._\s]*\d|\d/g), (m) => normaliseNumber(m[0]));
      if (wanted.length === 0 || !wanted.every((w) => numbers.has(w) || [...numbers].some((n) => n.replace(/\..*$/, "") === w.replace(/\..*$/, "")))) {
        problems.push(`figure "${f.label}": value "${f.value}" does not appear in ${f.source}`);
      }
      continue;
    }
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
  // Every amount, price or percentage in the prose must be among the sourced
  // figures: large numbers (5+ digits, or grouped 1,000,000), anything with a
  // currency or a % next to it, and "1.5 million" / "1.49M" style amounts.
  const cited = new Set(
    analysis.figures.flatMap((f) => Array.from(f.value.matchAll(/\d[\d,._]*\d|\d/g), (m) => normaliseNumber(m[0]))).filter(Boolean)
  );
  const known = (n: string) => cited.has(n) || [...cited].some((c) => c.replace(/\..*$/, "") === n.replace(/\..*$/, ""));
  const prose = [analysis.summary, analysis.whatChangesIfPassed, analysis.budgetNotes, ...analysis.argumentsFor, ...analysis.argumentsAgainst, ...analysis.tensions, analysis.suggestedVote.reason].join("\n");
  const patterns = [
    /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{5,}(?:\.\d+)?\b/g, // 1,800,000 / 9600000
    /(?:USD|US\$|\$|₳|ADA)\s?(\d[\d,]*(?:\.\d+)?)/g, // USD 0.30, $2.88, ₳22
    /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/g, // 70%, 4.92 percent
    /(\d[\d,]*(?:\.\d+)?)\s?(?:ADA|USD|lovelace)\b/g, // 200000 ADA
    /(\d+(?:\.\d+)?)\s?(?:million|M|billion|bn|k)\b/g, // 1.5 million, 1.49M
  ];
  const seen = new Set<string>();
  for (const re of patterns) {
    for (const m of prose.matchAll(re)) {
      const raw = m[1] ?? m[0];
      const n = normaliseNumber(raw);
      if (seen.has(`${re.source}|${m.index}`) || known(n)) continue;
      seen.add(`${re.source}|${m.index}`);
      problems.push(`amount "${m[0].trim()}" appears in the text but is not among the sourced figures`);
    }
  }
  return problems;
}

/** Gate 5: every cited id exists in the Constitution version in force. */
export function checkCitations(analysis: Analysis, constitution: SplitConstitution): string[] {
  const ids = new Set([...constitution.sections.map((s) => s.id), ...constitution.guardrails.map((g) => g.id)]);
  const problems: string[] = [];
  for (const c of analysis.constitutionSections) if (!ids.has(c.id)) problems.push(`constitution id "${c.id}" does not exist in this version`);
  // A guardrail or section id named anywhere in the text must exist too, not only in constitutionSections.
  const text = JSON.stringify({ ...analysis, figures: undefined });
  const named = new Set([
    ...Array.from(text.matchAll(/\b[A-Z]{2,16}-\d{2}[a-z]?\b/g), (m) => m[0]),
    ...Array.from(text.matchAll(/\b(?:art|app)-\d+(?:-(?:sec|s)\d+(?:-\d+)*)?\b/g), (m) => m[0]),
  ]);
  for (const id of named) if (!ids.has(id)) problems.push(`"${id}" is named in the text but does not exist in this Constitution version`);
  return problems;
}

export function validateAnalysis(raw: unknown, facts: Facts, constitution: SplitConstitution, document?: ProposalDocument): Analysis {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisRejected("schema", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const figures = checkFigures(parsed.data, facts, document);
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

> Prepared by the AdaSouls governance analyst${record.agent ? ` \`${record.agent}\`` : ""} under alma.yaml \`${record.almaVersion.slice(0, 16)}…\` (model ${record.model}, prompt ${record.promptVersion}) on ${record.analysedAt}${record.attempts && record.attempts.count > 1 ? `, after ${record.attempts.count} attempts (earlier answers failed: ${record.attempts.rejected.map((r) => r.check).join(", ")})` : ""}.
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

${renderContext(facts)}## Summary

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

| Figure | Value | Source | Status |
| --- | --- | --- | --- |
${a.figures.map((f) => `| ${f.label} | ${f.value} | \`${f.source}\` | ${figureKind(f.source) === "verified" ? "verified on chain" : "stated by the proposer, not verified"} |`).join("\n") || "| (none) | | | |"}
`;
}

/** Voting state, treasury and proposer history: code-derived facts, shown before the model's text. */
export function renderContext(facts: Facts): string {
  const out: string[] = [];
  const v = facts.voting;
  if (v) {
    const cls = (name: string, c: { yesPct: number | null; noPct: number | null; votesCast: { yes: number; no: number; abstain: number }; thresholdPct: number | null; meetsThreshold: boolean | null }) =>
      c.yesPct == null && c.thresholdPct == null && c.votesCast.yes + c.votesCast.no + c.votesCast.abstain === 0
        ? `| ${name} | — | — | — | ${c.thresholdPct != null ? `${c.thresholdPct}%` : "does not vote / unknown"} | — |`
        : `| ${name} | ${c.yesPct ?? "unknown"}% | ${c.noPct ?? "unknown"}% | ${c.votesCast.yes} / ${c.votesCast.no} / ${c.votesCast.abstain} | ${c.thresholdPct != null ? `${c.thresholdPct}%` : "unknown"} | ${c.meetsThreshold == null ? "unknown" : c.meetsThreshold ? "yes" : "no"} |`;
    out.push(
      `## Where the vote stands (epoch ${v.asOfEpoch}, ${v.fetchedAt})`,
      "",
      "| Class | Yes | No | Votes cast (Y / N / A) | Threshold | Meets it |",
      "| --- | --- | --- | --- | --- | --- |",
      cls("DReps", v.drep),
      cls("SPOs", v.spo),
      cls("Constitutional Committee", v.committee),
      "",
      `**Passing now:** ${v.passingNow == null ? "unknown" : v.passingNow ? "yes" : "no"}. ${v.note}`,
      ""
    );
  }
  const t = facts.treasury;
  if (t) {
    const n = t.netChangeLimit;
    out.push(
      `## Treasury (epoch ${t.asOfEpoch})`,
      "",
      "| | |",
      "| --- | --- |",
      `| Treasury balance | ${t.balanceAda ? `${t.balanceAda} ADA` : "unknown"} |`,
      `| Net Change Limit | ${n ? `${n.ada} ADA for epochs ${n.epochs.from}–${n.epochs.to} (Info action \`${n.actionKey}\`; DRep Yes ${n.drepYesPct ?? "?"}%, ${n.agreed == null ? "agreement unknown" : n.agreed ? "agreed" : "**not agreed by the policy's bar**"}) |` : "none configured |"}`,
      `| Enacted withdrawals in the period | ${t.enactedInPeriodAda ? `${t.enactedInPeriodAda} ADA` : "unknown"} |`,
      `| Remaining under the limit | ${t.remainingAda ? `${t.remainingAda} ADA` : "unknown"} |`,
      `| This action | ${t.thisActionAda} ADA — ${t.fitsRemaining == null ? "fit unknown" : t.fitsRemaining ? "fits" : "**exceeds what remains**"} |`,
      `| Other open withdrawals | ${t.otherOpenWithdrawalsAda} ADA |`,
      "",
      t.note,
      ""
    );
  }
  const h = facts.proposerHistory;
  if (h && h.returnAddress) {
    out.push(
      `## Other actions from the same return address`,
      "",
      h.actions.length
        ? ["| Action | Type | Proposed | Outcome | Withdrawals | Title (proposer's text) |", "| --- | --- | --- | --- | --- | --- |", ...h.actions.map((a) => `| \`${a.key.slice(0, 8)}…-${a.key.split("-")[1]}\` | ${a.type} | ${a.proposedEpoch ?? "?"} | ${a.outcome} | ${a.withdrawalsAda ? `${a.withdrawalsAda} ADA` : ""} | ${a.titleClaimed ?? ""} |`)].join("\n")
        : "- (none)",
      "",
      h.note,
      ""
    );
  }
  return out.length ? out.join("\n") + "\n" : "";
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
