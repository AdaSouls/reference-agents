import { anchorDigest, fetchAnchor, type FetchAnchorOptions } from "./anchor.js";
import { SPLITTER_VERSION, currentConstitutionAnchor, splitConstitution, type ConstitutionAnchor } from "./constitution.js";
import type { KoiosClient } from "./koios.js";
import type { ConstitutionSourceRecord, ConstitutionStore } from "./store.js";

/**
 * `gov constitution`: find the Constitution in force (latest enacted
 * NewConstitution action), fetch its bytes, verify the hash, split and
 * store. Mirrors are tried after the anchor URL fails; they are as
 * untrusted as the anchor's own host, because the hash decides either way.
 */

export interface ConstitutionSyncOptions {
  anchor?: FetchAnchorOptions;
  /** Alternative URLs for the same bytes, e.g. a GitHub raw file. Tried in order after the anchor URL. */
  mirrors?: string[];
  now?: () => Date;
  log?: (line: string) => void;
}

export type ConstitutionSyncResult =
  | { status: "verified"; anchor: ConstitutionAnchor; source: ConstitutionSourceRecord; alreadyStored: boolean }
  | { status: "unavailable"; anchor: ConstitutionAnchor; attempts: { url: string; reason: string }[] }
  | { status: "mismatch"; anchor: ConstitutionAnchor; attempts: { url: string; reason: string }[] }
  | { status: "no-anchor" };

export async function syncConstitution(
  koios: KoiosClient,
  store: ConstitutionStore,
  options: ConstitutionSyncOptions = {}
): Promise<ConstitutionSyncResult> {
  const log = options.log ?? (() => {});
  const anchor = currentConstitutionAnchor(await koios.proposalList());
  if (!anchor) return { status: "no-anchor" };
  log(`constitution in force: action ${anchor.actionKey} (enacted epoch ${anchor.enactedEpoch}), hash ${anchor.hash}`);

  const existing = await store.readSource(anchor.hash);
  if (existing) {
    const text = await store.readText(anchor.hash);
    if (text && anchorDigest(new TextEncoder().encode(text)) === anchor.hash) {
      if (existing.splitter === SPLITTER_VERSION) {
        log(`already stored and still verifies: ${store.dir(anchor.hash)}`);
        return { status: "verified", anchor, source: existing, alreadyStored: true };
      }
      // Same verified bytes, newer splitter: redo the split, keep the bytes.
      const split = splitConstitution(text);
      const source: ConstitutionSourceRecord = { ...existing, sections: split.sections.length, guardrails: split.guardrails.length, splitter: SPLITTER_VERSION };
      await store.save(anchor.hash, new TextEncoder().encode(text), split, source);
      log(`re-split with splitter v${SPLITTER_VERSION} (was v${existing.splitter ?? 1}): ${split.sections.length} sections, ${split.guardrails.length} guardrails`);
      return { status: "verified", anchor, source, alreadyStored: true };
    }
  }

  const attempts: { url: string; reason: string }[] = [];
  let sawMismatch = false;
  for (const url of [anchor.url, ...(options.mirrors ?? [])]) {
    const fetched = await fetchAnchor(url, anchor.hash, options.anchor);
    if (fetched.check.status === "verified" && fetched.bytes) {
      const text = new TextDecoder().decode(fetched.bytes);
      const split = splitConstitution(text);
      const source: ConstitutionSourceRecord = {
        hash: anchor.hash,
        anchorUrl: anchor.url,
        fetchedFrom: fetched.fetchedFrom !== anchor.url ? fetched.fetchedFrom : undefined,
        actionKey: anchor.actionKey,
        proposalId: anchor.proposalId,
        enactedEpoch: anchor.enactedEpoch,
        guardrailsScript: anchor.guardrailsScript,
        verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
        bytes: fetched.bytes.length,
        sections: split.sections.length,
        guardrails: split.guardrails.length,
        splitter: SPLITTER_VERSION,
      };
      await store.save(anchor.hash, fetched.bytes, split, source);
      log(`verified ${fetched.bytes.length} bytes from ${fetched.fetchedFrom ?? url}: ${split.sections.length} sections, ${split.guardrails.length} guardrails`);
      return { status: "verified", anchor, source, alreadyStored: false };
    }
    const reason =
      fetched.check.status === "mismatch"
        ? `mismatch: got ${fetched.check.digest}`
        : fetched.check.status === "unavailable"
          ? fetched.check.reason
          : "no anchor";
    if (fetched.check.status === "mismatch") sawMismatch = true;
    attempts.push({ url, reason });
    log(`${fetched.check.status.padEnd(11)} ${url}  ${reason}`);
  }
  return { status: sawMismatch ? "mismatch" : "unavailable", anchor, attempts };
}
