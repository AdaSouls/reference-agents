import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { anchorDigest } from "./anchor.js";
import type { AnalysisRecord } from "./analysis.js";
import { ANALYSIS_RECORD_TYPE, DECISION_RECORD_TYPE, signRecord, type SignedEnvelope } from "./signing.js";
import type { LocalSigner } from "@adasouls/alma-core";
import type { ActionStore } from "./store.js";

/**
 * G1.4: the human decision. `gov review <tx>-<ix>` records Yes / No /
 * Abstain and why, writes the final CIP-100 rationale from the draft,
 * computes its anchor hash the way `cardano-cli hash anchor-data
 * --file-text` does (blake2b-256 over the file bytes), and signs the
 * analysis and the decision with the analysis key. It never builds or
 * signs a vote transaction.
 */

export type Vote = "Yes" | "No" | "Abstain";

export interface DecidedBy {
  person: string;
  role: string;
}

export interface DecisionRecord {
  v: "alma-governance-decision/draft-1";
  key: string;
  actionId: string;
  vote: Vote;
  reason: string;
  suggestedVote: Vote;
  agreesWithAnalysis: boolean;
  /** SHA-256 over analysis.json's bytes: which analysis this decision answers. */
  analysisDigest: string;
  rationale: { file: string; anchorHash: string; bytes: number };
  decidedBy: DecidedBy;
  decidedAt: string;
}

export interface ReviewInput {
  vote: Vote;
  reason: string;
  /** Replaces the draft rationale's `comment` entirely when given; otherwise the draft is updated from vote + reason. */
  rationaleComment?: string;
  decidedBy: DecidedBy;
  /** Optional: sign analysis and decision. Without it, review still records the decision. */
  signer?: LocalSigner;
  /** Who signs (`self:<alma id>` for the agent's own key) and under which rules. Required with a signer. */
  issuer?: string;
  provenance?: { agent: string; almaVersion: string };
  now?: () => Date;
}

export interface ReviewResult {
  decision: DecisionRecord;
  files: { decision: string; rationale: string; analysisSignature?: string; decisionSignature?: string };
}

/** `decided_by` of the `vote` decision in escalation.yaml: who is allowed to decide. */
export async function decidedByFromEscalation(escalationFile: string): Promise<DecidedBy> {
  const doc = parseYaml(await readFile(escalationFile, "utf8")) as { decisions?: Array<{ id: string; decided_by?: { person?: string; role?: string } }> };
  const vote = doc.decisions?.find((d) => d.id === "vote");
  if (!vote?.decided_by?.person) throw new Error("escalation.yaml has no `vote` decision with a decided_by.person");
  return { person: vote.decided_by.person, role: vote.decided_by.role ?? "" };
}

function rewriteComment(draftComment: string, vote: Vote, reason: string, agrees: boolean, suggested: Vote): string {
  const lines = draftComment.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^VOTE:/.test(line)) out.push(`VOTE: ${vote}.`);
    else if (/^Why we vote this way:/.test(line)) out.push(`Why we vote this way: ${reason}`);
    else out.push(line);
  }
  if (!agrees) out.push("", `Note: the AI analysis suggested ${suggested}; the decision above is the human's, for the reasons given.`);
  return out.join("\n");
}

export async function reviewAction(key: string, actions: ActionStore, input: ReviewInput): Promise<ReviewResult> {
  const dir = actions.dir(key);
  const analysisBytes = await readFile(path.join(dir, "analysis.json")).catch(() => {
    throw new Error(`no analysis for ${key}; run \`gov analyse ${key}\` first`);
  });
  const record = JSON.parse(analysisBytes.toString("utf8")) as AnalysisRecord;
  const draft = JSON.parse(await readFile(path.join(dir, "rationale.draft.jsonld"), "utf8")) as { body: { comment: string } };
  const now = (input.now ?? (() => new Date()))();
  const suggested = record.analysis.suggestedVote.vote;
  const agrees = suggested === input.vote;

  // Final rationale: the draft with the human's words, written once; its bytes are what gets anchored.
  const rationale = structuredClone(draft);
  rationale.body.comment = input.rationaleComment ?? rewriteComment(draft.body.comment, input.vote, input.reason, agrees, suggested);
  const rationaleBytes = new TextEncoder().encode(JSON.stringify(rationale, null, 2) + "\n");
  const rationaleFile = path.join(dir, "rationale.jsonld");
  await writeFile(rationaleFile, rationaleBytes);
  const anchorHash = anchorDigest(rationaleBytes);

  const analysisDigest = await sha256Hex(analysisBytes);
  const decision: DecisionRecord = {
    v: "alma-governance-decision/draft-1",
    key,
    actionId: record.actionId,
    vote: input.vote,
    reason: input.reason,
    suggestedVote: suggested,
    agreesWithAnalysis: agrees,
    analysisDigest,
    rationale: { file: "rationale.jsonld", anchorHash, bytes: rationaleBytes.length },
    decidedBy: input.decidedBy,
    decidedAt: now.toISOString(),
  };
  const decisionFile = path.join(dir, "decision.json");
  await writeFile(decisionFile, JSON.stringify(decision, null, 2) + "\n");

  const files: ReviewResult["files"] = { decision: decisionFile, rationale: rationaleFile };
  if (input.signer) {
    if (!input.issuer || !input.provenance) throw new Error("signing needs the agent's issuer and provenance (its ALMA)");
    const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const analysisEnvelope = await signRecord(input.signer, {
      t: ANALYSIS_RECORD_TYPE,
      iss: input.issuer,
      kid: input.signer.kid,
      agent: input.provenance.agent,
      almaVersion: record.almaVersion ?? input.provenance.almaVersion,
      action: record.actionId,
      key,
      analysisDigest,
      constitution: record.constitutionHash,
      prompt: record.promptVersion,
      model: record.model,
      analysedAt: record.analysedAt,
      signedAt: ts,
    });
    const decisionEnvelope = await signRecord(input.signer, {
      t: DECISION_RECORD_TYPE,
      iss: input.issuer,
      kid: input.signer.kid,
      agent: input.provenance.agent,
      almaVersion: input.provenance.almaVersion,
      action: record.actionId,
      key,
      vote: input.vote,
      agreesWithAnalysis: agrees,
      analysisDigest,
      rationaleHash: anchorHash,
      decidedBy: input.decidedBy.person,
      decidedAt: decision.decidedAt,
    });
    files.analysisSignature = path.join(dir, "analysis.sig.json");
    files.decisionSignature = path.join(dir, "decision.sig.json");
    await writeFile(files.analysisSignature, JSON.stringify(analysisEnvelope, null, 2) + "\n");
    await writeFile(files.decisionSignature, JSON.stringify(decisionEnvelope, null, 2) + "\n");
  }
  return { decision, files };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type { SignedEnvelope };
