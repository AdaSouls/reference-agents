#!/usr/bin/env node
import "dotenv/config";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisRejected, loadSystemPrompt } from "./analysis.js";
import { analyseAction } from "./analyse.js";
import { syncConstitution } from "./constitution-sync.js";
import { anthropicCompleter } from "./model.js";
import { decidedByFromEscalation, reviewAction, type Vote } from "./review.js";
import { generateKeyFile, loadSigner } from "./signing.js";
import { ingest } from "./ingest.js";
import { KoiosClient } from "./koios.js";
import { ActionStore, ConstitutionStore } from "./store.js";

/**
 * gov ingest [--all]      list governance actions, verify anchors, store them
 * gov list                what is stored, with each anchor's verdict
 * gov constitution        the Constitution in force, verified and split into citable sections
 * gov analyse <tx>-<ix>   the analysis: facts + Constitution + the proposer's document -> model -> checks -> files
 * gov review <tx>-<ix> --vote Yes|No|Abstain --reason "..." [--comment-file f]
 *                         the human's decision: final rationale + its anchor hash, decision.json, signatures
 * gov keygen <file>       a new analysis key (PKCS#8); prints kid and public key, never the private key
 *
 * Later phases add
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
    case "analyse":
    case "analyze": {
      const key = rest.find((a) => !a.startsWith("--"));
      if (!key) {
        console.error("usage: gov analyse <tx>-<ix>");
        return 1;
      }
      const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
      const policyPath = env("CONFLICT_OF_INTEREST_POLICY");
      const policy = policyPath ? await readFile(policyPath, "utf8") : env("COI_TERMS") ? `Parties and topics that trigger a conflict of interest: ${env("COI_TERMS")}` : "";
      try {
        await analyseAction(key, store, new ConstitutionStore(env("DATA_DIR", "./data")!), {
          system: await loadSystemPrompt(promptsDir),
          completer: anthropicCompleter(env("ANALYSIS_MODEL", "claude-sonnet-4-5")!),
          conflictOfInterestPolicy: policy,
          analysisUrlTemplate: env("ANALYSIS_URL_TEMPLATE"),
          log: (line) => console.log(line),
        });
        return 0;
      } catch (err) {
        if (err instanceof AnalysisRejected) {
          console.error(`rejected (${err.check}); nothing written:`);
          for (const p of err.problems) console.error(`  - ${p}`);
          return 3;
        }
        throw err;
      }
    }
    case "review": {
      const key = rest.find((a) => !a.startsWith("--"));
      const flag = (name: string) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const vote = flag("vote") as Vote | undefined;
      const reason = flag("reason");
      if (!key || !vote || !["Yes", "No", "Abstain"].includes(vote) || !reason) {
        console.error('usage: gov review <tx>-<ix> --vote Yes|No|Abstain --reason "why" [--comment-file rationale-comment.txt]');
        return 1;
      }
      const here = path.dirname(fileURLToPath(import.meta.url));
      const decidedBy = await decidedByFromEscalation(path.join(here, "..", "escalation.yaml"));
      const keyFile = env("ANALYSIS_KEY_FILE");
      const signer = keyFile ? await loadSigner(keyFile) : undefined;
      if (!signer) console.log("ANALYSIS_KEY_FILE not set: the decision is recorded but not signed");
      const commentFile = flag("comment-file");
      const r = await reviewAction(key, store, {
        vote,
        reason,
        rationaleComment: commentFile ? await readFile(commentFile, "utf8") : undefined,
        decidedBy,
        signer,
      });
      console.log(`decision: ${r.decision.vote} by ${decidedBy.person}${r.decision.agreesWithAnalysis ? "" : ` (analysis suggested ${r.decision.suggestedVote})`}`);
      console.log(`rationale: ${r.files.rationale}`);
      console.log(`anchor hash (= cardano-cli hash anchor-data --file-text): ${r.decision.rationale.anchorHash}`);
      if (r.files.decisionSignature) console.log(`signed: ${r.files.analysisSignature}, ${r.files.decisionSignature} (kid ${signer!.kid})`);
      console.log("next: publish rationale.jsonld at a fixed URL, then vote with the Ledger per cardano-governance/docs/runbooks/drep-vote.md");
      return 0;
    }
    case "keygen": {
      const file = rest[0];
      if (!file) {
        console.error("usage: gov keygen <path to new key file>");
        return 1;
      }
      const { kid, publicKeyHex } = await generateKeyFile(file);
      console.log(`analysis key written to ${file} (mode 600). Publish these, keep the file private:\n  kid: ${kid}\n  public key (hex): ${publicKeyHex}`);
      return 0;
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
      console.error("usage: gov <ingest [--all] | constitution | analyse <tx>-<ix> | review <tx>-<ix> --vote V --reason R | keygen <file> | list>");
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
