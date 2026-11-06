import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { lovelaceToAda } from "./facts.js";
import { actionKey, isOpen, type KoiosClient, type Proposal, type ProtocolParams, type Totals, type VotingSummary } from "./koios.js";

/**
 * The context of one action at analysis time: where the vote stands, what
 * the treasury can still pay out under the recognised Net Change Limit,
 * and what else came from the same return address. All of it is computed
 * by code from Koios and the committed `context/treasury.yaml`; the model
 * reads the result as FACTS and computes nothing.
 *
 * `context.json` is a snapshot: voting state changes every block, so the
 * record says when it was taken and the analysis cites that snapshot.
 */

// ---------- treasury policy (context/treasury.yaml) ----------

export const nclEntrySchema = z
  .object({
    lovelace: z.string().regex(/^\d+$/),
    ada: z.string().regex(/^\d+$/),
    epochs: z.object({ from: z.number().int(), to: z.number().int() }),
    actionKey: z.string().regex(/^[0-9a-f]{64}-\d+$/),
    proposalId: z.string().min(1),
    anchorHash: z.string().regex(/^[0-9a-f]{64}$/),
    agreedWhen: z.string().min(1),
    drepYesAbovePct: z.number().min(0).max(100),
    supersedes: z.string().optional(),
  })
  .strict();
export type NclEntry = z.infer<typeof nclEntrySchema>;
export const treasuryPolicySchema = z.object({ netChangeLimits: z.array(nclEntrySchema) }).strict();
export type TreasuryPolicy = z.infer<typeof treasuryPolicySchema>;

export async function loadTreasuryPolicy(file: string): Promise<TreasuryPolicy> {
  const parsed = treasuryPolicySchema.safeParse(parseYaml(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** The entry whose period covers `epoch`; the latest proposed one when several do (a later agreement supersedes). */
export function nclFor(policy: TreasuryPolicy, epoch: number): NclEntry | undefined {
  const covering = policy.netChangeLimits.filter((n) => n.epochs.from <= epoch && epoch <= n.epochs.to);
  return covering.sort((a, b) => a.epochs.from - b.epochs.from).at(-1);
}

// ---------- the snapshot ----------

export interface ActionContext {
  v: "governance-analyst-context/1";
  key: string;
  fetchedAt: string;
  epoch: number;
  votingSummary: VotingSummary | null;
  protocolParams: ProtocolParams;
  totals: Totals | null;
  /** The recognised NCL entry and Koios' voting summary of the Info action that agreed it. */
  ncl: { entry: NclEntry; votingSummary: VotingSummary | null } | null;
}

export interface GatherOptions {
  now?: () => Date;
  log?: (line: string) => void;
}

export async function gatherContext(koios: KoiosClient, proposal: Proposal, policy: TreasuryPolicy, options: GatherOptions = {}): Promise<ActionContext> {
  const log = options.log ?? (() => {});
  const tip = await koios.tip();
  const [votingSummary, protocolParams, totals] = await Promise.all([
    koios.votingSummary(proposal.proposal_id),
    koios.protocolParams(),
    koios.totals(tip.epoch_no),
  ]);
  const entry = nclFor(policy, tip.epoch_no);
  const ncl = entry ? { entry, votingSummary: (await koios.votingSummary(entry.proposalId)) ?? null } : null;
  log(`context at epoch ${tip.epoch_no}: votes ${votingSummary ? "yes" : "none yet"}, treasury ${totals?.treasury != null ? lovelaceToAda(String(totals.treasury)) + " ADA" : "unknown"}, NCL ${entry ? entry.ada + " ADA" : "none configured"}`);
  return {
    v: "governance-analyst-context/1",
    key: actionKey(proposal),
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    epoch: tip.epoch_no,
    votingSummary: votingSummary ?? null,
    protocolParams,
    totals: totals ?? null,
    ncl,
  };
}

// ---------- facts derived from the snapshot ----------

export interface VoterClassFacts {
  yesPct: number | null;
  noPct: number | null;
  votesCast: { yes: number; no: number; abstain: number };
  /** The threshold of Yes stake this action type needs from this class, as a percentage; null when the class does not vote on it. */
  thresholdPct: number | null;
  /** yesPct ≥ thresholdPct, when both are known. */
  meetsThreshold: boolean | null;
}

export interface VotingFacts {
  asOfEpoch: number;
  fetchedAt: string;
  drep: VoterClassFacts & { yesPowerAda: string | null; noPowerAda: string | null; alwaysAbstainPowerAda: string | null; alwaysNoConfidencePowerAda: string | null };
  spo: VoterClassFacts;
  committee: VoterClassFacts;
  /** All classes that vote on this type meet their thresholds right now. null when any is unknown. */
  passingNow: boolean | null;
  note: string;
}

export interface TreasuryFacts {
  asOfEpoch: number;
  balanceAda: string | null;
  netChangeLimit: {
    ada: string;
    epochs: { from: number; to: number };
    actionKey: string;
    anchorHash: string;
    agreedWhen: string;
    /** DRep Yes of the Info action that agreed it, from Koios, against the policy's bar. */
    drepYesPct: number | null;
    agreed: boolean | null;
  } | null;
  /** Sum of every TreasuryWithdrawals enacted in the NCL period, from /proposal_list. */
  enactedInPeriodAda: string | null;
  remainingAda: string | null;
  /** This action's own withdrawals. */
  thisActionAda: string;
  fitsRemaining: boolean | null;
  /** Other open TreasuryWithdrawals competing for the same remainder. */
  otherOpenWithdrawalsAda: string;
  note: string;
}

export interface ProposerHistoryFacts {
  returnAddress: string | null;
  /** Other actions with the same return address, newest first. */
  actions: { key: string; type: string; proposedEpoch: number | null; outcome: "enacted" | "ratified" | "expired" | "dropped" | "open"; withdrawalsAda: string | null; titleClaimed: string | null }[];
  note: string;
}

export interface ContextFacts {
  voting: VotingFacts;
  treasury: TreasuryFacts | null;
  proposerHistory: ProposerHistoryFacts;
}

/** Which dRepVotingThresholds / poolVotingThresholds key governs each action type (CIP-1694). */
const DREP_THRESHOLD_KEY: Record<string, string | null> = {
  TreasuryWithdrawals: "treasuryWithdrawal",
  NoConfidence: "motionNoConfidence",
  NewCommittee: "committeeNormal",
  NewConstitution: "updateToConstitution",
  HardForkInitiation: "hardForkInitiation",
  // ParameterChange depends on the parameter group; reported as unknown rather than guessed.
  ParameterChange: null,
  InfoAction: null,
};
const POOL_THRESHOLD_KEY: Record<string, string | null> = {
  TreasuryWithdrawals: null,
  NoConfidence: "motionNoConfidence",
  NewCommittee: "committeeNormal",
  NewConstitution: null,
  HardForkInitiation: "hardForkInitiation",
  ParameterChange: null,
  InfoAction: null,
};
/** Classes that have a vote on each type; the committee votes on everything but NoConfidence and NewCommittee. */
const COMMITTEE_VOTES: Record<string, boolean> = {
  TreasuryWithdrawals: true,
  NoConfidence: false,
  NewCommittee: false,
  NewConstitution: true,
  HardForkInitiation: true,
  ParameterChange: true,
  InfoAction: true,
};

const pct = (fraction: number | undefined) => (fraction == null ? null : Math.round(fraction * 10000) / 100);
const adaOrNull = (v: string | number | null | undefined) => (v == null ? null : lovelaceToAda(String(v)));
const sumLovelace = (ps: Proposal[]) =>
  ps.reduce((acc, p) => acc + withdrawalLovelace(p), 0n);

export function withdrawalLovelace(p: Proposal): bigint {
  if (!Array.isArray(p.withdrawal)) return 0n;
  return (p.withdrawal as Array<{ amount?: string | number }>).reduce((acc, w) => (w?.amount != null ? acc + BigInt(String(w.amount)) : acc), 0n);
}

function voterClass(summary: VotingSummary | null, prefix: "drep" | "pool" | "committee", thresholdPct: number | null, votes: boolean): VoterClassFacts {
  if (!summary || !votes) {
    return { yesPct: null, noPct: null, votesCast: { yes: 0, no: 0, abstain: 0 }, thresholdPct: votes ? thresholdPct : null, meetsThreshold: null };
  }
  const s = summary as unknown as Record<string, number | null>;
  const yesPct = s[`${prefix}_yes_pct`] ?? null;
  return {
    yesPct,
    noPct: s[`${prefix}_no_pct`] ?? null,
    votesCast: { yes: s[`${prefix}_yes_votes_cast`] ?? 0, no: s[`${prefix}_no_votes_cast`] ?? 0, abstain: s[`${prefix}_abstain_votes_cast`] ?? 0 },
    thresholdPct,
    meetsThreshold: yesPct != null && thresholdPct != null ? yesPct >= thresholdPct : null,
  };
}

export function contextFacts(proposal: Proposal, context: ActionContext, allProposals: Proposal[]): ContextFacts {
  const type = proposal.proposal_type;
  const drepKey = DREP_THRESHOLD_KEY[type] ?? null;
  const poolKey = POOL_THRESHOLD_KEY[type] ?? null;
  const drepThreshold = drepKey ? pct(context.protocolParams.dRepVotingThresholds?.[drepKey]) : null;
  const poolThreshold = poolKey ? pct(context.protocolParams.poolVotingThresholds?.[poolKey]) : null;
  const s = context.votingSummary;
  const drep = voterClass(s, "drep", drepThreshold, true);
  const spo = voterClass(s, "pool", poolThreshold, poolKey != null);
  // The committee's threshold is its own quorum, not a protocol parameter; Koios reports the pct, so > 50 is reported, the bar as unknown.
  const committee = voterClass(s, "committee", null, COMMITTEE_VOTES[type] ?? true);
  const classChecks = [drep.meetsThreshold, ...(poolKey ? [spo.meetsThreshold] : [])];
  const passingNow = classChecks.every((c) => c === true) ? true : classChecks.some((c) => c === false) ? false : null;
  const voting: VotingFacts = {
    asOfEpoch: context.epoch,
    fetchedAt: context.fetchedAt,
    drep: {
      ...drep,
      yesPowerAda: adaOrNull(s?.drep_yes_vote_power),
      noPowerAda: adaOrNull(s?.drep_no_vote_power),
      alwaysAbstainPowerAda: adaOrNull(s?.drep_always_abstain_vote_power),
      alwaysNoConfidencePowerAda: adaOrNull(s?.drep_always_no_confidence_vote_power),
    },
    spo,
    committee,
    passingNow,
    note: s
      ? `Koios /proposal_voting_summary at epoch ${context.epoch}; percentages are of active voting stake as Koios computes them; thresholds are the current protocol parameters for a ${type}${drepKey ? "" : " (DRep threshold depends on the parameter group or is not ledger-ratified: unknown)"}; the committee's bar is its own quorum (unknown here).`
      : `Koios has no votes for this action yet (epoch ${context.epoch}).`,
  };

  let treasury: TreasuryFacts | null = null;
  if (type === "TreasuryWithdrawals") {
    const thisLovelace = withdrawalLovelace(proposal);
    const thisKey = actionKey(proposal);
    const otherOpen = allProposals.filter((p) => p.proposal_type === "TreasuryWithdrawals" && isOpen(p) && actionKey(p) !== thisKey);
    const n = context.ncl;
    let enacted: bigint | null = null;
    let remaining: bigint | null = null;
    let agreed: boolean | null = null;
    if (n) {
      enacted = sumLovelace(allProposals.filter((p) => p.proposal_type === "TreasuryWithdrawals" && p.enacted_epoch != null && p.enacted_epoch >= n.entry.epochs.from && p.enacted_epoch <= n.entry.epochs.to));
      remaining = BigInt(n.entry.lovelace) - enacted;
      agreed = n.votingSummary?.drep_yes_pct != null ? n.votingSummary.drep_yes_pct > n.entry.drepYesAbovePct : null;
    }
    treasury = {
      asOfEpoch: context.epoch,
      balanceAda: adaOrNull(context.totals?.treasury),
      netChangeLimit: n
        ? {
            ada: n.entry.ada,
            epochs: n.entry.epochs,
            actionKey: n.entry.actionKey,
            anchorHash: n.entry.anchorHash,
            agreedWhen: n.entry.agreedWhen,
            drepYesPct: n.votingSummary?.drep_yes_pct ?? null,
            agreed,
          }
        : null,
      enactedInPeriodAda: enacted != null ? lovelaceToAda(enacted.toString()) : null,
      remainingAda: remaining != null ? lovelaceToAda((remaining < 0n ? 0n : remaining).toString()) : null,
      thisActionAda: lovelaceToAda(thisLovelace.toString()),
      fitsRemaining: remaining != null ? thisLovelace <= remaining : null,
      otherOpenWithdrawalsAda: lovelaceToAda(sumLovelace(otherOpen).toString()),
      note: n
        ? `NCL from context/treasury.yaml (Info action ${n.entry.actionKey}), checked against Koios' DRep vote on it; enacted withdrawals summed from /proposal_list rows with enacted_epoch in ${n.entry.epochs.from}–${n.entry.epochs.to}; balance from /totals at epoch ${context.epoch}.`
        : `No Net Change Limit configured for epoch ${context.epoch} in context/treasury.yaml; remaining is unknown.`,
    };
  }

  const ra = proposal.return_address ?? null;
  const thisKey = actionKey(proposal);
  const actions = ra
    ? allProposals
        .filter((p) => p.return_address === ra && actionKey(p) !== thisKey)
        .sort((a, b) => (b.proposed_epoch ?? 0) - (a.proposed_epoch ?? 0))
        .map((p) => ({
          key: actionKey(p),
          type: p.proposal_type,
          proposedEpoch: p.proposed_epoch ?? null,
          outcome: (p.enacted_epoch != null ? "enacted" : p.ratified_epoch != null ? "ratified" : p.expired_epoch != null ? "expired" : p.dropped_epoch != null ? "dropped" : "open") as ProposerHistoryFacts["actions"][number]["outcome"],
          withdrawalsAda: p.proposal_type === "TreasuryWithdrawals" ? lovelaceToAda(withdrawalLovelace(p).toString()) : null,
          titleClaimed: claimedTitle(p),
        }))
    : [];
  const proposerHistory: ProposerHistoryFacts = {
    returnAddress: ra,
    actions,
    note: "Actions sharing this deposit return address. A shared return address means the same wallet got the deposits back, not necessarily the same proposer (submission services reuse addresses). Titles are the proposers' own text.",
  };

  return { voting, treasury, proposerHistory };
}

function claimedTitle(p: Proposal): string | null {
  const body = (p.meta_json as { body?: { title?: unknown } } | null | undefined)?.body;
  return typeof body?.title === "string" ? body.title.slice(0, 120) : null;
}
