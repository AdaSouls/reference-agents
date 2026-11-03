import { fetchAnchor, type FetchAnchorOptions } from "./anchor.js";
import { actionKey, isOpen, type KoiosClient, type Proposal } from "./koios.js";
import type { ActionCheckRecord, ActionStore } from "./store.js";

/**
 * G1.1: list the open governance actions, download each anchor, check its
 * hash against the on-chain one, store the result. A mismatch or a failed
 * download is a recorded outcome, never a skipped action.
 */

export interface IngestOptions {
  /** Include closed actions too (ratified / enacted / dropped / expired). Default: open only. */
  all?: boolean;
  anchor?: FetchAnchorOptions;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface IngestSummary {
  seen: number;
  ingested: number;
  verified: number;
  mismatch: number;
  unavailable: number;
  none: number;
  records: ActionCheckRecord[];
}

export async function ingestOne(
  proposal: Proposal,
  store: ActionStore,
  options: IngestOptions = {}
): Promise<ActionCheckRecord> {
  const key = actionKey(proposal);
  await store.saveOnchain(key, proposal);
  const fetched = await fetchAnchor(proposal.meta_url, proposal.meta_hash, options.anchor);
  if (fetched.bytes) await store.saveAnchor(key, fetched.bytes);
  const record: ActionCheckRecord = {
    key,
    proposalId: proposal.proposal_id,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    anchorUrl: proposal.meta_url ?? null,
    anchorHash: proposal.meta_hash ?? null,
    anchor: fetched.check,
    contentType: fetched.contentType,
  };
  await store.saveCheck(key, record);
  return record;
}

export async function ingest(koios: KoiosClient, store: ActionStore, options: IngestOptions = {}): Promise<IngestSummary> {
  const log = options.log ?? (() => {});
  const proposals = await koios.proposalList();
  const wanted = options.all ? proposals : proposals.filter(isOpen);
  const summary: IngestSummary = { seen: proposals.length, ingested: 0, verified: 0, mismatch: 0, unavailable: 0, none: 0, records: [] };
  for (const p of wanted) {
    const record = await ingestOne(p, store, options);
    summary.ingested += 1;
    summary[record.anchor.status] += 1;
    summary.records.push(record);
    const detail =
      record.anchor.status === "verified"
        ? `${record.anchor.bytes} bytes`
        : record.anchor.status === "mismatch"
          ? `expected ${record.anchor.expected.slice(0, 12)}… got ${record.anchor.digest.slice(0, 12)}…`
          : record.anchor.status === "unavailable"
            ? record.anchor.reason
            : "no anchor on chain";
    log(`${record.anchor.status.padEnd(11)} ${record.key}  ${p.proposal_type}  ${detail}`);
  }
  return summary;
}
