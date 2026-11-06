import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorDigest, fetchAnchor } from "../src/anchor.js";
import { ingest } from "../src/ingest.js";
import { KoiosClient, actionKey, isOpen, proposalListSchema } from "../src/koios.js";
import { ActionStore } from "../src/store.js";

const fixtures = path.join(import.meta.dirname, "fixtures");

/** A fetch that serves the recorded Koios list and the anchor files; nothing leaves the process. */
async function recordedFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/proposal_list")) {
    return new Response(await readFile(path.join(fixtures, "proposal_list.json")), { headers: { "content-type": "application/json" } });
  }
  const m = /^https:\/\/anchors\.example\/(.+)$/.exec(url);
  if (m) {
    try {
      const body = await readFile(path.join(fixtures, "anchors", m[1]));
      return new Response(body, { headers: { "content-type": "application/ld+json" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}

const fetchImpl = recordedFetch as unknown as typeof fetch;

describe("anchor", () => {
  it("hashes like cardano-cli hash anchor-data (blake2b-256 of the bytes)", async () => {
    const bytes = await readFile(path.join(fixtures, "anchors", "info-good.jsonld"));
    expect(anchorDigest(bytes)).toBe("f7ffe23a8a34f7b34dde2c158bb67fdda789c5dd9a6c6d596824a07fdba75426");
  });

  it("verifies when the digest matches, keeps a mismatch as evidence, records unavailability", async () => {
    const h = "f7ffe23a8a34f7b34dde2c158bb67fdda789c5dd9a6c6d596824a07fdba75426";
    const ok = await fetchAnchor("https://anchors.example/info-good.jsonld", h, { fetch: fetchImpl });
    expect(ok.check.status).toBe("verified");
    expect(ok.bytes?.length).toBeGreaterThan(0);

    const bad = await fetchAnchor("https://anchors.example/info-tampered.jsonld", h, { fetch: fetchImpl });
    expect(bad.check.status).toBe("mismatch");
    expect(bad.bytes?.length).toBeGreaterThan(0);

    const gone = await fetchAnchor("https://anchors.example/missing.jsonld", h, { fetch: fetchImpl });
    expect(gone.check).toEqual({ status: "unavailable", reason: "HTTP 404" });

    expect((await fetchAnchor(null, h)).check).toEqual({ status: "none" });
    expect((await fetchAnchor("ipfs://bafy", h)).check.status).toBe("unavailable");
  });

  it("falls through rate-limited gateways to the next one", async () => {
    const h = "f7ffe23a8a34f7b34dde2c158bb67fdda789c5dd9a6c6d596824a07fdba75426";
    const tried: string[] = [];
    const gateways = (async (input: string | URL) => {
      const url = String(input);
      tried.push(url);
      if (url.startsWith("https://busy.example/")) return new Response("slow down", { status: 429 });
      return new Response(await readFile(path.join(fixtures, "anchors", "info-good.jsonld")));
    }) as unknown as typeof fetch;
    const r = await fetchAnchor("ipfs://QmFixture/info-good.jsonld", h, { fetch: gateways, ipfsGateway: "https://busy.example/ipfs/, https://ok.example/ipfs/" });
    expect(r.check.status).toBe("verified");
    expect(r.fetchedFrom).toBe("https://ok.example/ipfs/QmFixture/info-good.jsonld");
    expect(tried).toHaveLength(2);
    const allBusy = await fetchAnchor("ipfs://QmFixture/x", h, { fetch: gateways, ipfsGateway: "https://busy.example/ipfs/,https://busy.example/ipfs2/" });
    expect(allBusy.check.status).toBe("unavailable");
    expect((allBusy.check as { reason: string }).reason).toContain("429");
  });

  it("fetches ipfs:// anchors through the configured gateway, and the hash still decides", async () => {
    const h = "f7ffe23a8a34f7b34dde2c158bb67fdda789c5dd9a6c6d596824a07fdba75426";
    const gateway = (async (input: string | URL) => {
      expect(String(input)).toBe("https://gw.example/ipfs/QmFixture/info-good.jsonld");
      return new Response(await readFile(path.join(fixtures, "anchors", "info-good.jsonld")));
    }) as unknown as typeof fetch;
    const r = await fetchAnchor("ipfs://QmFixture/info-good.jsonld", h, { fetch: gateway, ipfsGateway: "https://gw.example/ipfs/" });
    expect(r.check.status).toBe("verified");
    expect(r.fetchedFrom).toBe("https://gw.example/ipfs/QmFixture/info-good.jsonld");
  });

  it("refuses bodies over the size limit instead of hashing them", async () => {
    const r = await fetchAnchor("https://anchors.example/info-good.jsonld", "00".repeat(32), { fetch: fetchImpl, maxBytes: 10 });
    expect(r.check.status).toBe("unavailable");
  });
});

describe("koios", () => {
  it("parses the recorded /proposal_list and tells open from closed", async () => {
    const list = proposalListSchema.parse(JSON.parse(await readFile(path.join(fixtures, "proposal_list.json"), "utf8")));
    expect(list).toHaveLength(7);
    expect(list.filter(isOpen).map((p) => p.proposal_type)).toEqual(["InfoAction", "TreasuryWithdrawals", "ParameterChange"]);
    expect(actionKey(list[2])).toBe(`${"3".repeat(64)}-1`);
  });

  it("sends the bearer key only when configured", async () => {
    const seen: Record<string, string>[] = [];
    const spy = (async (_url: string, init?: RequestInit) => {
      seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await new KoiosClient({ fetch: spy }).proposalList();
    await new KoiosClient({ fetch: spy, apiKey: "k" }).proposalList();
    expect(seen[0].authorization).toBeUndefined();
    expect(seen[1].authorization).toBe("Bearer k");
  });
});

describe("ingest", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "gov-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("stores every open action with its verdict, and never skips a failure", async () => {
    const store = new ActionStore(dataDir);
    const lines: string[] = [];
    const summary = await ingest(new KoiosClient({ fetch: fetchImpl }), store, {
      anchor: { fetch: fetchImpl },
      now: () => new Date("2026-11-03T00:00:00Z"),
      log: (l) => lines.push(l),
    });
    expect(summary).toMatchObject({ seen: 7, ingested: 3, verified: 1, mismatch: 1, unavailable: 1, none: 0 });
    expect(lines).toHaveLength(3);

    const keys = await store.keys();
    expect(keys).toEqual([`${"1".repeat(64)}-0`, `${"2".repeat(64)}-0`, `${"3".repeat(64)}-1`]);

    const good = await store.readCheck(keys[0]);
    expect(good?.anchor.status).toBe("verified");
    expect(good?.checkedAt).toBe("2026-11-03T00:00:00.000Z");
    await stat(path.join(store.dir(keys[0]), "anchor.bin"));
    await stat(path.join(store.dir(keys[0]), "onchain.json"));

    const tampered = await store.readCheck(keys[1]);
    expect(tampered?.anchor.status).toBe("mismatch");
    // The tampered bytes are kept: a reviewer can see what the proposer served.
    await stat(path.join(store.dir(keys[1]), "anchor.bin"));

    const missing = await store.readCheck(keys[2]);
    expect(missing?.anchor).toEqual({ status: "unavailable", reason: "HTTP 404" });
    await expect(stat(path.join(store.dir(keys[2]), "anchor.bin"))).rejects.toThrow();
  });

  it("includes closed actions only with --all", async () => {
    const store = new ActionStore(dataDir);
    const summary = await ingest(new KoiosClient({ fetch: fetchImpl }), store, { all: true, anchor: { fetch: fetchImpl } });
    expect(summary.ingested).toBe(7);
  });
});

describe("standard", () => {
  it("the ALMA manifest parses and grants no payment capability", async () => {
    const { parseManifestYaml } = await import("@adasouls/alma-manifest");
    const manifest = parseManifestYaml(await readFile(path.join(import.meta.dirname, "..", "alma.yaml"), "utf8"));
    expect(manifest.metadata.name).toBe("governance-analyst");
    expect(manifest.capabilities).not.toContain("pay");
    expect(manifest.authority?.maxTransaction).toBeUndefined();
  });
});
