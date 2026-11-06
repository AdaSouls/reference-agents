#!/usr/bin/env node
import "dotenv/config";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisRejected, loadSystemPrompt } from "./analysis.js";
import { analyseAction } from "./analyse.js";
import { loadTreasuryPolicy } from "./context.js";
import { syncConstitution } from "./constitution-sync.js";
import { anthropicCompleter } from "./model.js";
import { anchorUrl, hashFile, publish } from "./publish.js";
import { decidedByFromEscalation, reviewAction, type Vote } from "./review.js";
import { AlmaRefusal, guard, loadAgentSigner, loadAlma, selfIssuer, type Command } from "./alma.js";
import { ingest } from "./ingest.js";
import { KoiosClient } from "./koios.js";
import { ActionStore, ConstitutionStore } from "./store.js";

/**
 * gov ingest [--all]      list governance actions, verify anchors, store them
 * gov list                what is stored, with each anchor's verdict
 * gov constitution        the Constitution in force, verified and split into citable sections
 * gov analyse <tx>-<ix>   the analysis: facts (+ voting state, treasury, proposer history from Koios) + Constitution + the proposer's document -> model -> checks -> files
 * gov review <tx>-<ix> --vote Yes|No|Abstain --reason "..." [--comment-file f]
 *                         the human's decision: final rationale + its anchor hash, decision.json, signatures
 * gov whoami              the agent's ALMA: identity, principal, delegation, rules, almaVersion, key id
 * gov publish [--all]     copy decided actions into cardano-governance/votes/ and regenerate its README
 * gov anchor <tx>-<ix> --commit <sha> [--check]   the immutable raw URL for the vote's anchor, and its hash
 * gov hash <file>         blake2b-256 of a file (= cardano-cli hash anchor-data --file-text)
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

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const store = new ActionStore(env("DATA_DIR", "./data")!);
  const network = env("CARDANO_NETWORK", "cardano:mainnet")!;
  // Every command that acts reads the agent's ALMA first and refuses outside it.
  const almaFor = async (cmd: Command, ctx: { actionType?: string; includeUndecided?: boolean } = {}) => {
    const alma = loadAlma(projectDir);
    guard(alma, cmd, { network, ...ctx });
    return alma;
  };
  switch (command) {
    case "ingest": {
      await almaFor("ingest");
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
      await almaFor("constitution");
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
        console.error("usage: gov analyse <tx>-<ix> [--offline]   (--offline: reuse the stored voting/treasury snapshot)");
        return 1;
      }
      const alma = await almaFor("analyse", { actionType: (await store.readOnchain(key))?.proposal_type });
      const promptsDir = path.join(projectDir, "prompts");
      const policyPath = env("CONFLICT_OF_INTEREST_POLICY");
      const policy = policyPath ? await readFile(policyPath, "utf8") : env("COI_TERMS") ? `Parties and topics that trigger a conflict of interest: ${env("COI_TERMS")}` : "";
      try {
        await analyseAction(key, store, new ConstitutionStore(env("DATA_DIR", "./data")!), {
          context: {
            koios: rest.includes("--offline") ? undefined : new KoiosClient({ baseUrl: env("KOIOS_BASE_URL"), apiKey: env("KOIOS_API_KEY") }),
            treasuryPolicy: await loadTreasuryPolicy(path.join(projectDir, "context", "treasury.yaml")),
          },
          system: await loadSystemPrompt(promptsDir),
          completer: anthropicCompleter(env("ANALYSIS_MODEL", "claude-sonnet-4-5")!),
          conflictOfInterestPolicy: policy,
          analysisUrlTemplate: env("ANALYSIS_URL_TEMPLATE"),
          maxAttempts: Number(env("ANALYSIS_MAX_ATTEMPTS", "3")),
          provenance: { agent: alma.identity!.id, almaVersion: alma.almaVersion },
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
      const alma = await almaFor("review");
      const decidedBy = await decidedByFromEscalation(path.join(projectDir, "escalation.yaml"));
      const signer = await loadAgentSigner(alma);
      const commentFile = flag("comment-file");
      const r = await reviewAction(key, store, {
        vote,
        reason,
        rationaleComment: commentFile ? await readFile(commentFile, "utf8") : undefined,
        decidedBy,
        signer,
        issuer: selfIssuer(alma.identity!.id),
        provenance: { agent: alma.identity!.id, almaVersion: alma.almaVersion },
      });
      console.log(`decision: ${r.decision.vote} by ${decidedBy.person}${r.decision.agreesWithAnalysis ? "" : ` (analysis suggested ${r.decision.suggestedVote})`}`);
      console.log(`rationale: ${r.files.rationale}`);
      console.log(`anchor hash (= cardano-cli hash anchor-data --file-text): ${r.decision.rationale.anchorHash}`);
      if (r.files.decisionSignature) console.log(`signed by ${alma.identity!.id}: ${r.files.analysisSignature}, ${r.files.decisionSignature} (kid ${signer.kid})`);
      console.log("next: publish rationale.jsonld at a fixed URL, then vote with the Ledger per cardano-governance/docs/runbooks/drep-vote.md");
      return 0;
    }
    case "keygen": {
      console.error("`gov keygen` is gone: the agent signs with its ALMA key. Run `alma connect` in this directory (see README), then `gov whoami`.");
      return 1;
    }
    case "whoami": {
      const alma = loadAlma(projectDir);
      console.log(`I am ${alma.identity?.id ?? "(no ALMA identity yet: run `alma connect`)"}${alma.identity?.principal ? `, for ${alma.identity.principal}` : ""}.`);
      console.log(`Rules: alma.yaml ${alma.almaVersion}`);
      console.log(`  capabilities: ${alma.capabilities.join(", ")}`);
      console.log(`  networks: ${alma.governance.networks.join(", ")}  (this run: ${network})`);
      console.log(`  action types: ${alma.governance.actionTypes?.join(", ") ?? "all"}`);
      console.log(`  a person decides: ${alma.governance.humanDecides?.join(", ") ?? "nothing reserved"}`);
      console.log(`  analyses published: ${alma.governance.publish ?? "after-decision"}`);
      console.log(
        alma.delegation
          ? `Delegated by ${alma.delegation.issuer}: [${alma.delegation.scope.capabilities.join(", ")}]${alma.delegation.expiresAt ? ` until ${alma.delegation.expiresAt.slice(0, 10)}` : ""}`
          : "No active delegation: run `alma connect` (or `alma limits` to renew)."
      );
      try {
        console.log(`Signing key: ${(await loadAgentSigner(alma)).kid}`);
      } catch {
        console.log("Signing key: none yet (alma connect creates .alma/issuer.key)");
      }
      console.log("Enforcement: declared and self-enforced (ADVISORY). This agent refuses commands outside alma.yaml; nothing on chain enforces it.");
      return 0;
    }
    case "publish": {
      const governanceDir = env("GOVERNANCE_DIR");
      if (!governanceDir) {
        console.error("set GOVERNANCE_DIR to a checkout of AdaSouls/cardano-governance");
        return 1;
      }
      await almaFor("publish", { includeUndecided: rest.includes("--all") });
      const published = await publish(store, { governanceDir, includeUndecided: rest.includes("--all"), log: (line) => console.log(line) });
      console.log(`\n${published.length} action(s) in ${path.join(governanceDir, "votes")}. Review the diff, commit, then \`gov anchor <key> --commit <sha> --check\`.`);
      return 0;
    }
    case "anchor": {
      const key = rest.find((a) => !a.startsWith("--"));
      const i = rest.indexOf("--commit");
      const commit = i >= 0 ? rest[i + 1] : undefined;
      if (!key || !commit) {
        console.error("usage: gov anchor <tx>-<ix> --commit <sha> [--check]");
        return 1;
      }
      await almaFor("anchor");
      const r = await anchorUrl(key, store, { branchOrCommit: commit, check: rest.includes("--check"), repo: env("GOVERNANCE_REPO") });
      console.log(`--anchor-url ${r.url}`);
      console.log(`--anchor-data-hash ${r.expectedHash}`);
      if (r.check) console.log(`check: ${r.check}${r.detail ? ` (${r.detail})` : ""}`);
      else if (r.detail) console.log(`warning: ${r.detail}`);
      return r.check === "mismatch" ? 2 : 0;
    }
    case "hash": {
      if (!rest[0]) {
        console.error("usage: gov hash <file>");
        return 1;
      }
      console.log(await hashFile(rest[0]));
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
      console.error("usage: gov <ingest [--all] | constitution | analyse <key> | review <key> --vote V --reason R | publish [--all] | anchor <key> --commit <sha> [--check] | hash <file> | whoami | list>");
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof AlmaRefusal) {
      console.error(`refused by alma.yaml: ${err.message}`);
      process.exit(4);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
