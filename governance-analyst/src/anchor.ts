import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Governance anchors (CIP-100 / CIP-108): a URL and the blake2b-256 of the
 * bytes at it, both on chain. `cardano-cli hash anchor-data` computes the
 * same digest. The bytes are untrusted data (security.md): we fetch exactly
 * the URL the chain names, once, within limits, and keep them only as
 * bytes plus a verdict.
 */

export function anchorDigest(bytes: Uint8Array): string {
  return bytesToHex(blake2b(bytes, { dkLen: 32 }));
}

export type AnchorCheck =
  | { status: "verified"; digest: string; bytes: number }
  | { status: "mismatch"; digest: string; expected: string; bytes: number }
  | { status: "unavailable"; reason: string }
  | { status: "none" };

export interface FetchAnchorOptions {
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * Where `ipfs://<cid>[/path]` anchors are fetched from: one gateway or
   * several, comma-separated, tried in order ("https://ipfs.io/ipfs/,
   * https://dweb.link/ipfs/"). Public gateways rate-limit (HTTP 429) and
   * drop unpinned content, so more than one is normal. A gateway is
   * untrusted like any host: the bytes still have to hash to the on-chain
   * anchor hash, so a lying gateway yields a mismatch, never a false
   * "verified". Unset: ipfs:// anchors are recorded as unavailable.
   */
  ipfsGateway?: string;
}

export interface FetchedAnchor {
  check: AnchorCheck;
  /** The URL that was actually fetched (differs from the anchor URL for ipfs://). */
  fetchedFrom?: string;
  /** Present when something was downloaded, verified or not: a mismatch is kept as evidence. */
  bytes?: Uint8Array;
  contentType?: string;
}

/**
 * The URLs to try for an anchor, in order: http(s) as is; ipfs:// through
 * each configured gateway; anything else (file:, data:, ar://) is not fetched.
 */
export function resolveAnchorUrls(url: string, ipfsGateway?: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (u.protocol === "https:" || u.protocol === "http:") return [url];
  if (u.protocol === "ipfs:" && ipfsGateway) {
    // ipfs://<cid>/<path> parses with the cid as host; keep cid + path, drop any query.
    const cidAndPath = `${u.hostname}${u.pathname}`.replace(/^\/+/, "");
    if (!cidAndPath) return [];
    return ipfsGateway
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
      .map((g) => `${g.replace(/\/$/, "")}/${cidAndPath}`);
  }
  return [];
}

/** First candidate, for callers that only need one. */
export function resolveAnchorUrl(url: string, ipfsGateway?: string): string | undefined {
  return resolveAnchorUrls(url, ipfsGateway)[0];
}

export async function fetchAnchor(
  url: string | null | undefined,
  expectedHash: string | null | undefined,
  options: FetchAnchorOptions = {}
): Promise<FetchedAnchor> {
  if (!url || !expectedHash) return { check: { status: "none" } };
  const targets = resolveAnchorUrls(url, options.ipfsGateway);
  if (targets.length === 0) {
    const reason = url.startsWith("ipfs://") && !options.ipfsGateway ? `ipfs anchor and no IPFS_GATEWAY configured: ${url}` : `unsupported url: ${url}`;
    return { check: { status: "unavailable", reason } };
  }
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const expected = expectedHash.toLowerCase();
  const failures: string[] = [];
  for (const target of targets) {
    let res: Response;
    try {
      res = await fetchImpl(target, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const cause = (err as Error & { cause?: Error }).cause;
      failures.push(`${target}: fetch failed: ${cause?.message ?? (err as Error).message}`);
      continue;
    }
    if (!res.ok) {
      failures.push(`${target}: HTTP ${res.status}`);
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      failures.push(`${target}: content-length ${declared} > ${maxBytes}`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) {
      failures.push(`${target}: body ${bytes.length} > ${maxBytes}`);
      continue;
    }
    const digest = anchorDigest(bytes);
    const contentType = res.headers.get("content-type") ?? undefined;
    if (digest === expected) return { check: { status: "verified", digest, bytes: bytes.length }, bytes, contentType, fetchedFrom: target };
    // A mismatch is a verdict about the content, not about the gateway: stop here and keep the evidence.
    return { check: { status: "mismatch", digest, expected, bytes: bytes.length }, bytes, contentType, fetchedFrom: target };
  }
  return { check: { status: "unavailable", reason: failures.length === 1 ? failures[0].replace(/^[^:]+:\/\/[^ ]+: /, "") : failures.join(" | ") }, fetchedFrom: targets[0] };
}
