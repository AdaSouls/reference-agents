import type { Proposal } from "./koios.js";
import type { ActionCheckRecord } from "./store.js";

/**
 * The verified, code-derived facts about one action: the only place the
 * analysis may take figures from. Built from onchain.json + check.json;
 * the model never sees Koios directly and never computes an amount.
 */

export interface Facts {
  actionId: string;
  key: string;
  txHash: string;
  index: number;
  type: string;
  proposedEpoch: number | null;
  expiresEpoch: number | null;
  /** The epoch the analysis is made in, when known (from Koios tip). */
  currentEpoch?: number;
  deposit: { lovelace: string; ada: string } | null;
  returnAddress: string | null;
  previousActionId: string | null;
  withdrawals: { stakeAddress: string; lovelace: string; ada: string }[];
  /** For ParameterChange: the proposed parameter set as reported by Koios. */
  paramProposal: unknown;
  /** Free-form description Koios carries (tag + contents); shown as data. */
  description: unknown;
  anchor: {
    url: string | null;
    hash: string | null;
    status: ActionCheckRecord["anchor"]["status"];
    detail?: string;
  };
}

/** Lovelace → ADA as an exact decimal string, no floats ("940000000000" → "940000", "1500000" → "1.5"). */
export function lovelaceToAda(lovelace: string | number): string {
  const s = String(lovelace).replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(s)) throw new Error(`not a lovelace amount: ${lovelace}`);
  const whole = s.length > 6 ? s.slice(0, -6) : "0";
  const frac = s.padStart(7, "0").slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function buildFacts(proposal: Proposal, check: ActionCheckRecord): Facts {
  const withdrawals = Array.isArray(proposal.withdrawal)
    ? (proposal.withdrawal as Array<{ stake_address?: string; amount?: string | number }>)
        .filter((w) => w && w.amount != null)
        .map((w) => ({ stakeAddress: String(w.stake_address ?? ""), lovelace: String(w.amount), ada: lovelaceToAda(String(w.amount)) }))
    : [];
  const deposit = proposal.deposit != null ? { lovelace: String(proposal.deposit), ada: lovelaceToAda(String(proposal.deposit)) } : null;
  const a = check.anchor;
  return {
    actionId: proposal.proposal_id,
    key: check.key,
    txHash: proposal.proposal_tx_hash,
    index: proposal.proposal_index,
    type: proposal.proposal_type,
    proposedEpoch: proposal.proposed_epoch ?? null,
    expiresEpoch: proposal.expiration ?? null,
    deposit,
    returnAddress: proposal.return_address ?? null,
    previousActionId: proposal.previous_gov_action_proposal_id ?? null,
    withdrawals,
    paramProposal: proposal.param_proposal ?? null,
    description: proposal.proposal_description ?? null,
    anchor: {
      url: check.anchorUrl,
      hash: check.anchorHash,
      status: a.status,
      detail: a.status === "mismatch" ? `bytes hashed to ${a.digest}, chain says ${a.expected}` : a.status === "unavailable" ? a.reason : undefined,
    },
  };
}

/** Read a `FACTS.a.b[0].c` path. Returns undefined when it does not resolve. */
export function resolveFactPath(facts: Facts, path: string): unknown {
  const m = /^FACTS((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$/.exec(path.trim());
  if (!m) return undefined;
  let cur: unknown = facts;
  for (const step of m[1].match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) ?? []) {
    if (cur == null || typeof cur !== "object") return undefined;
    const keyName = step.startsWith("[") ? Number(step.slice(1, -1)) : step.slice(1);
    cur = (cur as Record<string | number, unknown>)[keyName];
  }
  return cur;
}

/**
 * The proposer's document, reduced to the CIP-108 fields we show the
 * model. Parsed only as JSON; anything else is shown as text. Always data.
 */
export interface ProposalDocument {
  format: "cip108" | "json" | "text" | "none";
  title?: string;
  abstract?: string;
  motivation?: string;
  rationale?: string;
  references?: unknown;
  /** The raw text when it is not CIP-108 JSON, truncated to `maxChars`. */
  text?: string;
  truncated: boolean;
}

export function describeProposalDocument(bytes: Uint8Array | undefined, maxChars = 60_000): ProposalDocument {
  if (!bytes || bytes.length === 0) return { format: "none", truncated: false };
  const text = new TextDecoder().decode(bytes);
  try {
    const json = JSON.parse(text) as { body?: Record<string, unknown> };
    const body = json.body;
    if (body && typeof body === "object" && ("title" in body || "abstract" in body || "motivation" in body)) {
      const cut = (v: unknown) => (typeof v === "string" ? v.slice(0, maxChars) : undefined);
      const lengths = ["title", "abstract", "motivation", "rationale"].map((k) => (typeof body[k] === "string" ? (body[k] as string).length : 0));
      return {
        format: "cip108",
        title: cut(body.title),
        abstract: cut(body.abstract),
        motivation: cut(body.motivation),
        rationale: cut(body.rationale),
        references: body.references,
        truncated: lengths.some((n) => n > maxChars),
      };
    }
    return { format: "json", text: text.slice(0, maxChars), truncated: text.length > maxChars };
  } catch {
    return { format: "text", text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
}
