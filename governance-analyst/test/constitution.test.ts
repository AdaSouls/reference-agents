import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorDigest } from "../src/anchor.js";
import { syncConstitution } from "../src/constitution-sync.js";
import { currentConstitutionAnchor, findCitable, splitConstitution } from "../src/constitution.js";
import { KoiosClient, proposalListSchema } from "../src/koios.js";
import { ConstitutionStore } from "../src/store.js";

const fixtures = path.join(import.meta.dirname, "fixtures");

/** On-chain hash of the Constitution in force on mainnet (NewConstitution 91a79f5c…-0, enacted epoch 609). */
const CURRENT_HASH = "b368bdad83c727bbfe86425575233fb914eb76d05d89497f7790cf007fd95f52";

describe("which Constitution is in force", () => {
  it("picks the latest enacted NewConstitution action, with its anchor and guardrails script", async () => {
    const actions = proposalListSchema.parse(JSON.parse(await readFile(path.join(fixtures, "new_constitution_actions.json"), "utf8")));
    const anchor = currentConstitutionAnchor(actions);
    expect(anchor).toMatchObject({
      hash: CURRENT_HASH,
      url: "ipfs://bafkreieyuknozbtewyurfqoagvplvykadn6a4u6wglupavdz46bbsnnl6e",
      enactedEpoch: 609,
      guardrailsScript: "fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64",
    });
    expect(anchor!.actionKey.startsWith("91a79f5c934b7c91")).toBe(true);
    // Expired / dropped proposals (c882…, 207b…) and the older enacted one (8c65…, epoch 542) are not it.
  });

  it("returns nothing when no NewConstitution was enacted", () => {
    expect(currentConstitutionAnchor([])).toBeUndefined();
  });
});

describe("splitting", () => {
  it("gives articles, sections, appendix headings and guardrails stable ids from the document's own numbering", async () => {
    const text = await readFile(path.join(fixtures, "constitution-excerpt.md"), "utf8");
    const split = splitConstitution(text);
    const ids = split.sections.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["preamble", "defined-terms", "art-1", "art-1-sec-1", "art-1-sec-2", "art-2", "art-2-sec-1", "art-4", "art-4-sec-1", "app-1", "app-1-s1", "app-1-s2", "app-1-s2-guardrails", "app-1-s2-1", "app-2"])
    );
    expect(new Set(ids).size).toBe(ids.length);

    const sec = split.sections.find((s) => s.id === "art-1-sec-1")!;
    expect(sec.title).toBe("Section 1 Guiding Tenets");
    expect(sec.parent).toBe("art-1");
    expect(sec.level).toBe(1);
    expect(sec.text.startsWith("### **Section 1 Guiding Tenets**")).toBe(true);

    expect(split.guardrails.map((g) => g.id)).toEqual(["PARAM-01", "PARAM-02a"]);
    expect(split.guardrails[0]).toMatchObject({ section: "app-1-s2-guardrails", checkable: true });
    expect(findCitable(split, "PARAM-02a")?.text).toContain("Checkable Guardrails are shown by a (y)");
    expect(findCitable(split, "art-9-sec-1")).toBeUndefined();
  });

  it("is deterministic: the same text splits to the same ids twice", async () => {
    const text = await readFile(path.join(fixtures, "constitution-excerpt.md"), "utf8");
    expect(splitConstitution(text)).toEqual(splitConstitution(text));
  });

  // Gate 2 of the test plan, against the full text when it is on disk (e.g. a clone of
  // IntersectMBO/cardano-constitution): the bytes hash to the on-chain anchor and the
  // split covers the whole document.
  it.skipIf(!process.env.CONSTITUTION_FILE)("the full Constitution hashes to the on-chain anchor and splits whole", async () => {
    const bytes = await readFile(process.env.CONSTITUTION_FILE!);
    expect(anchorDigest(bytes)).toBe(CURRENT_HASH);
    const split = splitConstitution(bytes.toString("utf8"));
    expect(split.sections.filter((s) => s.level === 0).map((s) => s.id)).toEqual(["preamble", "defined-terms", "art-1", "art-2", "art-3", "art-4", "app-1", "app-2"]);
    expect(split.sections.find((s) => s.id === "art-2-sec-7")?.title).toContain("Treasury Withdrawals");
    expect(split.guardrails.length).toBeGreaterThan(100);
    // Long family names and partial markers: TREASURY-02a (x), HARDFORK-01 (~ - no access …).
    expect(split.guardrails.find((g) => g.id === "TREASURY-02a")?.section).toBe("app-1-s3-guardrails");
    expect(split.guardrails.find((g) => g.id === "HARDFORK-01")).toBeTruthy();
  });
});

describe("gov constitution", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "gov-const-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function fakeNet(opts: { anchorBody?: Uint8Array; mirrorBody?: Uint8Array }) {
    const calls: string[] = [];
    const f = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/proposal_list")) return new Response(await readFile(path.join(fixtures, "new_constitution_actions.json")));
      if (url.startsWith("https://gw.example/ipfs/")) return opts.anchorBody ? new Response(opts.anchorBody) : new Response("gateway timeout", { status: 504 });
      if (url.startsWith("https://mirror.example/")) return opts.mirrorBody ? new Response(opts.mirrorBody) : new Response("nope", { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it("stores the Constitution only when some source's bytes hash to the on-chain anchor", async () => {
    const excerpt = await readFile(path.join(fixtures, "constitution-excerpt.md"));
    // The excerpt is not the real document, so against the real hash it must be a mismatch everywhere.
    const net = fakeNet({ anchorBody: excerpt, mirrorBody: excerpt });
    const store = new ConstitutionStore(dataDir);
    const r = await syncConstitution(new KoiosClient({ fetch: net.f }), store, {
      anchor: { fetch: net.f, ipfsGateway: "https://gw.example/ipfs/" },
      mirrors: ["https://mirror.example/constitution.md"],
    });
    expect(r.status).toBe("mismatch");
    expect(await store.currentHash()).toBeUndefined();
    expect(net.calls.filter((c) => !c.endsWith("/proposal_list"))).toHaveLength(2);
  });

  it("falls back to a mirror when the anchor URL is unavailable, and records where the bytes came from", async () => {
    // A document whose hash we control: patch the expected hash by using a fixture-only Koios list.
    const excerpt = await readFile(path.join(fixtures, "constitution-excerpt.md"));
    const h = anchorDigest(excerpt);
    const actions = JSON.parse(await readFile(path.join(fixtures, "new_constitution_actions.json"), "utf8")) as Array<Record<string, unknown>>;
    const patched = actions.map((a) => {
      if (!String(a.proposal_tx_hash).startsWith("91a79f5c")) return a;
      const d = structuredClone(a.proposal_description) as { contents: [unknown, { anchor: { dataHash: string } }] };
      d.contents[1].anchor.dataHash = h;
      return { ...a, proposal_description: d };
    });
    const f = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/proposal_list")) return new Response(JSON.stringify(patched));
      if (url.startsWith("https://gw.example/ipfs/")) return new Response("down", { status: 502 });
      if (url === "https://mirror.example/constitution.md") return new Response(excerpt);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const store = new ConstitutionStore(dataDir);
    const r = await syncConstitution(new KoiosClient({ fetch: f }), store, {
      anchor: { fetch: f, ipfsGateway: "https://gw.example/ipfs/" },
      mirrors: ["https://mirror.example/constitution.md"],
      now: () => new Date("2026-11-04T00:00:00Z"),
    });
    expect(r.status).toBe("verified");
    if (r.status !== "verified") return;
    expect(r.source).toMatchObject({ hash: h, fetchedFrom: "https://mirror.example/constitution.md", enactedEpoch: 609, verifiedAt: "2026-11-04T00:00:00.000Z" });
    expect(await store.currentHash()).toBe(h);
    expect((await store.readText(h))?.length).toBe(excerpt.toString("utf8").length);
    const sections = await store.readSections<{ sections: unknown[]; guardrails: unknown[] }>(h);
    expect(sections?.guardrails).toHaveLength(2);

    // Second run: already stored, still verifies, nothing fetched beyond the list.
    const again = await syncConstitution(new KoiosClient({ fetch: f }), store, { anchor: { fetch: f } });
    expect(again.status).toBe("verified");
    if (again.status === "verified") expect(again.alreadyStored).toBe(true);
  });
});
