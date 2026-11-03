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
}

export interface FetchedAnchor {
  check: AnchorCheck;
  /** Present when something was downloaded, verified or not: a mismatch is kept as evidence. */
  bytes?: Uint8Array;
  contentType?: string;
}

/** Only http(s); anything else (ipfs://, file:, data:) is left to a gateway decision we haven't made. */
export function isFetchableAnchorUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function fetchAnchor(
  url: string | null | undefined,
  expectedHash: string | null | undefined,
  options: FetchAnchorOptions = {}
): Promise<FetchedAnchor> {
  if (!url || !expectedHash) return { check: { status: "none" } };
  if (!isFetchableAnchorUrl(url)) return { check: { status: "unavailable", reason: `unsupported url scheme: ${url}` } };
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { check: { status: "unavailable", reason: `fetch failed: ${(err as Error).message}` } };
  }
  if (!res.ok) return { check: { status: "unavailable", reason: `HTTP ${res.status}` } };
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { check: { status: "unavailable", reason: `content-length ${declared} > ${maxBytes}` } };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) return { check: { status: "unavailable", reason: `body ${bytes.length} > ${maxBytes}` } };
  const digest = anchorDigest(bytes);
  const contentType = res.headers.get("content-type") ?? undefined;
  const expected = expectedHash.toLowerCase();
  if (digest === expected) return { check: { status: "verified", digest, bytes: bytes.length }, bytes, contentType };
  return { check: { status: "mismatch", digest, expected, bytes: bytes.length }, bytes, contentType };
}
