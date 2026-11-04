import { readFile, writeFile } from "node:fs/promises";
import { LocalSigner, canonicalJsonValue } from "@adasouls/alma-core";

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toBase64Url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/**
 * Signed records in alma-core's issuer-signature shape: a flat payload
 * with a type tag `t`, the issuer `iss` and key id `kid` inside it (so a
 * signature cannot be re-labelled), Ed25519 over the JCS bytes, and an
 * envelope { payload, alg, sig }.
 *
 * The two types here are *drafts* of what G6.1 will add to alma-core as
 * `alma-attestation/1`; until then they are verifiable by anyone with the
 * published key but are not accepted by the transparency log. The key is
 * the AdaSouls analysis key: it signs records and moves nothing. It is read
 * from ANALYSIS_KEY_FILE (PKCS#8 DER) and never printed.
 */

export const ANALYSIS_RECORD_TYPE = "alma-governance-analysis/draft-1";
export const DECISION_RECORD_TYPE = "alma-governance-decision/draft-1";
export const ISSUER = "adasouls.io";

export interface SignedEnvelope<P extends Record<string, string | number | boolean | null>> {
  payload: P;
  alg: "Ed25519";
  sig: string;
}

export async function loadSigner(keyFile: string): Promise<LocalSigner> {
  return LocalSigner.fromPkcs8(new Uint8Array(await readFile(keyFile)));
}

/** Creates a new key file. Prints nothing secret: the caller gets kid and public key only. */
export async function generateKeyFile(keyFile: string): Promise<{ kid: string; publicKeyHex: string }> {
  const signer = await LocalSigner.generate();
  await writeFile(keyFile, await signer.exportPkcs8(), { mode: 0o600 });
  return { kid: signer.kid, publicKeyHex: toHex(signer.publicKey) };
}

export async function signRecord<P extends Record<string, string | number | boolean | null>>(
  signer: LocalSigner,
  payload: P
): Promise<SignedEnvelope<P>> {
  if (payload.kid !== signer.kid) throw new Error("payload.kid must be the signer's kid");
  const sig = await signer.sign(new TextEncoder().encode(canonicalJsonValue(payload)));
  return { payload, alg: "Ed25519", sig: toBase64Url(sig) };
}

/** Verification with nothing but the raw public key: what a reader of `votes/` does. */
export async function verifyRecord(envelope: { payload: unknown; alg: string; sig: string }, rawPublicKey: Uint8Array): Promise<boolean> {
  if (envelope.alg !== "Ed25519") return false;
  const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(rawPublicKey), { name: "Ed25519" }, false, ["verify"]);
  const sig = new Uint8Array(Buffer.from(envelope.sig, "base64url"));
  return globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(canonicalJsonValue(envelope.payload)));
}
