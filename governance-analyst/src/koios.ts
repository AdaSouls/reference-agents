import { z } from "zod";

/**
 * The slice of Koios we read (https://api.koios.rest, OpenAPI
 * `koiosapi-mainnet.yaml`). Read-only; one indexer's view of the chain,
 * which security.md treats as untrusted-but-consistent until a second
 * provider cross-checks it.
 */

export const PROPOSAL_TYPES = [
  "ParameterChange",
  "HardForkInitiation",
  "TreasuryWithdrawals",
  "NoConfidence",
  "NewCommittee",
  "NewConstitution",
  "InfoAction",
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

/** `GET /proposal_list`. Unknown fields are kept (passthrough) so the raw record is stored whole. */
export const proposalSchema = z
  .object({
    block_time: z.number().nullable().optional(),
    /** CIP-129 bech32, `gov_action1...`. */
    proposal_id: z.string().min(1),
    proposal_tx_hash: z.string().regex(/^[0-9a-f]{64}$/),
    proposal_index: z.number().int().nonnegative(),
    proposal_type: z.enum(PROPOSAL_TYPES),
    proposal_description: z.unknown().optional(),
    previous_gov_action_proposal_id: z.string().nullable().optional(),
    deposit: z.union([z.string(), z.number()]).nullable().optional(),
    return_address: z.string().nullable().optional(),
    proposed_epoch: z.number().int().nullable().optional(),
    ratified_epoch: z.number().int().nullable().optional(),
    enacted_epoch: z.number().int().nullable().optional(),
    dropped_epoch: z.number().int().nullable().optional(),
    expired_epoch: z.number().int().nullable().optional(),
    expiration: z.number().int().nullable().optional(),
    meta_url: z.string().nullable().optional(),
    /** blake2b-256 of the anchor bytes, hex. */
    meta_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
    meta_json: z.unknown().optional(),
    meta_comment: z.string().nullable().optional(),
    meta_language: z.string().nullable().optional(),
    meta_is_valid: z.boolean().nullable().optional(),
    withdrawal: z.unknown().optional(),
    param_proposal: z.unknown().optional(),
  })
  .passthrough();
export type Proposal = z.infer<typeof proposalSchema>;

export const proposalListSchema = z.array(proposalSchema);

/** `GET /proposal_voting_summary?_proposal_id=`: vote power and counts per voter class, as of Koios' tip. */
export const votingSummarySchema = z
  .object({
    proposal_type: z.string().optional(),
    epoch_no: z.number().int().nullable().optional(),
    drep_yes_votes_cast: z.number().int(),
    drep_no_votes_cast: z.number().int(),
    drep_abstain_votes_cast: z.number().int(),
    drep_yes_vote_power: z.union([z.string(), z.number()]).nullable(),
    drep_no_vote_power: z.union([z.string(), z.number()]).nullable(),
    drep_active_yes_vote_power: z.union([z.string(), z.number()]).nullable().optional(),
    drep_active_no_vote_power: z.union([z.string(), z.number()]).nullable().optional(),
    drep_active_abstain_vote_power: z.union([z.string(), z.number()]).nullable().optional(),
    drep_always_no_confidence_vote_power: z.union([z.string(), z.number()]).nullable().optional(),
    drep_always_abstain_vote_power: z.union([z.string(), z.number()]).nullable().optional(),
    drep_yes_pct: z.number().nullable(),
    drep_no_pct: z.number().nullable(),
    pool_yes_votes_cast: z.number().int(),
    pool_no_votes_cast: z.number().int(),
    pool_abstain_votes_cast: z.number().int(),
    pool_yes_pct: z.number().nullable(),
    pool_no_pct: z.number().nullable(),
    committee_yes_votes_cast: z.number().int(),
    committee_no_votes_cast: z.number().int(),
    committee_abstain_votes_cast: z.number().int(),
    committee_yes_pct: z.number().nullable(),
    committee_no_pct: z.number().nullable(),
  })
  .passthrough();
export type VotingSummary = z.infer<typeof votingSummarySchema>;

/** `GET /cli_protocol_params`: the Conway voting thresholds, in cardano-cli's JSON shape. */
export const protocolParamsSchema = z
  .object({
    dRepVotingThresholds: z.record(z.string(), z.number()).optional(),
    poolVotingThresholds: z.record(z.string(), z.number()).optional(),
    govActionLifetime: z.number().int().optional(),
  })
  .passthrough();
export type ProtocolParams = z.infer<typeof protocolParamsSchema>;

/** `GET /totals?_epoch_no=`: supply figures per epoch; `treasury` is in lovelace. */
export const totalsSchema = z
  .object({ epoch_no: z.number().int(), treasury: z.union([z.string(), z.number()]).nullable() })
  .passthrough();
export type Totals = z.infer<typeof totalsSchema>;

export const tipSchema = z.object({ epoch_no: z.number().int(), block_time: z.number().optional() }).passthrough();

/** Open = not yet ratified, enacted, dropped or expired. */
export function isOpen(p: Proposal): boolean {
  return p.ratified_epoch == null && p.enacted_epoch == null && p.dropped_epoch == null && p.expired_epoch == null;
}

/** The directory name PLAN.md uses: `<tx id>-<index>`. */
export function actionKey(p: Pick<Proposal, "proposal_tx_hash" | "proposal_index">): string {
  return `${p.proposal_tx_hash}-${p.proposal_index}`;
}

export interface KoiosOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class KoiosClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: KoiosOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.koios.rest/api/v1").replace(/\/$/, "");
    this.apiKey = options.apiKey || undefined;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async get(path: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`koios ${path}: HTTP ${res.status}`);
    return res.json();
  }

  private async parsed<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await this.get(path));
    if (!parsed.success) throw new Error(`koios ${path.split("?")[0]}: unexpected shape: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  /** Every governance action Koios knows about; filter with `isOpen` for the live ones. */
  async proposalList(): Promise<Proposal[]> {
    return this.parsed("/proposal_list", proposalListSchema);
  }

  /** Where the vote stands for one action; undefined when Koios has no row for it. */
  async votingSummary(proposalId: string): Promise<VotingSummary | undefined> {
    const rows = await this.parsed(`/proposal_voting_summary?_proposal_id=${encodeURIComponent(proposalId)}`, z.array(votingSummarySchema));
    return rows[0];
  }

  async protocolParams(): Promise<ProtocolParams> {
    return this.parsed("/cli_protocol_params", protocolParamsSchema);
  }

  async totals(epoch: number): Promise<Totals | undefined> {
    const rows = await this.parsed(`/totals?_epoch_no=${epoch}`, z.array(totalsSchema));
    return rows[0];
  }

  async tip(): Promise<{ epoch_no: number }> {
    const rows = await this.parsed("/tip", z.array(tipSchema));
    if (!rows[0]) throw new Error("koios /tip: empty");
    return rows[0];
  }
}
