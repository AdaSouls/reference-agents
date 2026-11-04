#!/usr/bin/env node
import "dotenv/config";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { syncConstitution } from "./constitution-sync.js";
import { ingest } from "./ingest.js";
import { KoiosClient } from "./koios.js";
import { ActionStore, ConstitutionStore } from "./store.js";

/**
 * gov ingest [--all]      list governance actions, verify anchors, store them
 * gov list                what is stored, with each anchor's verdict
 * gov constitution        the Constitution in force, verified and split into citable sections
 *
 * Later phases add `gov analyse <tx>-<ix>`,
 * `gov review <tx>-<ix>` and `gov publish`. None of them ever builds or
 * submits a transaction (agent.yaml, security.md).
 */

// Node's fetch ignores HTTP(S)_PROXY; honour it, as curl and the SDKs do, for
// corporate and sandboxed networks. No proxy configured: nothing changes.
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const env = (name: string, fallback?: string): string | undefined => process.env[name]?.trim() || fallback;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const store = new ActionStore(env("DATA_DIR", "./data")!);
  switch (command) {
    case "ingest": {
      const koios = new KoiosClient({ baseUrl: env("KOIOS_BASE_URL"), apiKey: env("KOIOS_API_KEY") });
      const summary = await ingest(koios, store, {
        all: rest.includes("--all"),
        anchor: {
          maxBytes: Number(env("ANCHOR_MAX_BYTES", "2000000")),
          timeoutMs: Number(env("ANCHOR_TIMEOUT_MS", "20000")),
          ipfsGateway: env("IPFS_GATEWAY"),
        },
        log: (line) => console.log(line),
      });
      console.log(
        `\n${summary.ingested} of ${summary.seen} actions ingested: ${summary.verified} verified, ${summary.mismatch} mismatch, ${summary.unavailable} unavailable, ${summary.none} without anchor`
      );
      return summary.mismatch > 0 ? 2 : 0;
    }
    case "constitution": {
      const koios = new KoiosClient({ baseUrl: env("KOIOS_BASE_URL"), apiKey: env("KOIOS_API_KEY") });
      const result = await syncConstitution(koios, new ConstitutionStore(env("DATA_DIR", "./data")!), {
        anchor: {
          maxBytes: Number(env("ANCHOR_MAX_BYTES", "2000000")),
          timeoutMs: Number(env("ANCHOR_TIMEOUT_MS", "20000")),
          ipfsGateway: env("IPFS_GATEWAY"),
        },
        mirrors: (env("CONSTITUTION_MIRRORS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        log: (line) => console.log(line),
      });
      if (result.status === "verified") return 0;
      if (result.status === "no-anchor") {
        console.error("no enacted NewConstitution action found");
        return 1;
      }
      console.error(`constitution ${result.status}: no source produced bytes matching ${result.anchor.hash}`);
      return result.status === "mismatch" ? 2 : 1;
    }
    case "list": {
      const keys = await store.keys();
      if (keys.length === 0) {
        console.log("nothing ingested yet; run `gov ingest`");
        return 0;
      }
      for (const key of keys) {
        const check = await store.readCheck(key);
        const onchain = await store.readOnchain(key);
        console.log(`${(check?.anchor.status ?? "?").padEnd(11)} ${key}  ${onchain?.proposal_type ?? "?"}  ${check?.checkedAt ?? ""}`);
      }
      return 0;
    }
    default:
      console.error("usage: gov <ingest [--all] | constitution | list>");
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
