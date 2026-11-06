import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { almaIdentitySchema, delegationSchema, LocalSigner, type AlmaIdentity, type Delegation } from "@adasouls/alma-core";
import { parseManifestYaml } from "@adasouls/alma-manifest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { anchorDigest } from "./anchor.js";

/**
 * The agent's ALMA: who it is, who it represents, what it was delegated,
 * and the rules it runs under. Every command reads this first and refuses
 * to act outside it (STANDARD.md rule 9).
 *
 *   alma.yaml              the rules, committed: a change is a PR and a new almaVersion
 *   .alma/identity.json    who this deployment of the agent is (alma connect)
 *   .alma/delegations.json what its principal delegated, and until when
 *   .alma/issuer.key       the agent's signing key (PKCS#8 Ed25519, mode 600, never in git)
 *
 * The rules are declared and self-enforced here: a verifier reports them
 * as ADVISORY. What this adds is provenance: every signed record names the
 * agent and the exact alma.yaml (almaVersion) it was produced under.
 */

export const GOVERNANCE_ACTION_TYPES = [
  "ParameterChange",
  "HardForkInitiation",
  "TreasuryWithdrawals",
  "NoConfidence",
  "NewCommittee",
  "NewConstitution",
  "InfoAction",
] as const;

/**
 * Mirrors the `governance` section of @adasouls/alma-manifest (alma PR #27).
 * The published 0.2.x manifest package predates it and strips the key, so
 * it is validated here until that release; then this becomes an import.
 */
export const governanceSchema = z
  .object({
    networks: z.array(z.string().regex(/^cardano:[a-z0-9-]+$/)).min(1),
    actionTypes: z.array(z.enum(GOVERNANCE_ACTION_TYPES)).min(1).optional(),
    humanDecides: z.array(z.string().min(1)).optional(),
    publish: z.enum(["after-decision", "immediately"]).optional(),
  })
  .strict();
export type Governance = z.infer<typeof governanceSchema>;

export interface AgentAlma {
  projectDir: string;
  name: string;
  capabilities: string[];
  governance: Governance;
  /** blake2b-256 of alma.yaml's bytes: which rules a record was produced under. */
  almaVersion: string;
  identity?: AlmaIdentity;
  /** The active, unexpired delegation from the identity's principal, if any. */
  delegation?: Delegation;
  keyFile: string;
}

export class AlmaRefusal extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function loadAlma(projectDir: string, now = new Date()): AgentAlma {
  const manifestPath = path.join(projectDir, "alma.yaml");
  if (!existsSync(manifestPath)) throw new AlmaRefusal("no alma.yaml in this agent: its rules are missing");
  const bytes = readFileSync(manifestPath);
  const text = bytes.toString("utf8");
  let base;
  try {
    base = parseManifestYaml(text);
  } catch (err) {
    throw new AlmaRefusal(`alma.yaml is not a valid ALMA manifest: ${(err as Error).message}`);
  }
  const raw = parseYaml(text) as { governance?: unknown };
  const gov = governanceSchema.safeParse(raw.governance);
  if (!gov.success) throw new AlmaRefusal(`alma.yaml has no valid governance section: ${gov.error.issues[0]?.path.join(".")} ${gov.error.issues[0]?.message}`);

  const almaDir = path.join(projectDir, ".alma");
  const identityRaw = readJson(path.join(almaDir, "identity.json"));
  const identity = identityRaw ? almaIdentitySchema.parse(identityRaw) : undefined;
  const delegations = ((readJson(path.join(almaDir, "delegations.json")) as unknown[]) ?? []).map((d) => delegationSchema.parse(d));
  const delegation = identity
    ? delegations.find(
        (d) => d.subject === identity.id && d.issuer === identity.principal && d.status === "active" && (!d.expiresAt || Date.parse(d.expiresAt) > now.getTime())
      )
    : undefined;

  return {
    projectDir,
    name: base.metadata.name,
    capabilities: base.capabilities,
    governance: gov.data,
    almaVersion: anchorDigest(new Uint8Array(bytes)),
    identity,
    delegation,
    keyFile: path.join(almaDir, "issuer.key"),
  };
}

export type Command = "ingest" | "constitution" | "analyse" | "review" | "publish" | "anchor";

/** What each command needs from the agent's ALMA. */
const NEEDS: Record<Command, { capability?: string; identity: boolean }> = {
  ingest: { identity: false },
  constitution: { identity: false },
  analyse: { capability: "analyze", identity: true },
  review: { capability: "attest", identity: true },
  publish: { capability: "attest", identity: true },
  anchor: { identity: false },
};

export interface GuardContext {
  network: string;
  actionType?: string;
  /** publish --all: analyses without a decision. */
  includeUndecided?: boolean;
}

/** Throws AlmaRefusal when the command is outside what alma.yaml and the delegation allow. */
export function guard(alma: AgentAlma, command: Command, ctx: GuardContext): void {
  // This agent never votes. A manifest that grants it `vote` is a configuration error, not a permission.
  if (alma.capabilities.includes("vote")) throw new AlmaRefusal("alma.yaml grants `vote`: the governance analyst never votes; remove it");
  if (!alma.governance.networks.includes(ctx.network)) {
    throw new AlmaRefusal(`network ${ctx.network} is not in alma.yaml governance.networks (${alma.governance.networks.join(", ")})`);
  }
  const need = NEEDS[command];
  if (need.capability && !alma.capabilities.includes(need.capability)) {
    throw new AlmaRefusal(`\`${command}\` needs the \`${need.capability}\` capability, which alma.yaml does not declare`);
  }
  if (need.identity) {
    if (!alma.identity) throw new AlmaRefusal(`\`${command}\` signs records: this agent has no ALMA identity yet; run \`alma connect\` in ${alma.projectDir}`);
    if (!alma.identity.principal) throw new AlmaRefusal("the agent's identity names no principal: nobody delegated anything to it");
    if (!alma.delegation) throw new AlmaRefusal(`no active delegation from ${alma.identity.principal} to ${alma.identity.id}: run \`alma connect\` (or \`alma limits\` to renew)`);
    if (need.capability && !alma.delegation.scope.capabilities.includes(need.capability)) {
      throw new AlmaRefusal(`${alma.identity.principal} did not delegate \`${need.capability}\` to this agent`);
    }
  }
  if (command === "analyse" && ctx.actionType && alma.governance.actionTypes && !alma.governance.actionTypes.includes(ctx.actionType as never)) {
    throw new AlmaRefusal(`action type ${ctx.actionType} is not in alma.yaml governance.actionTypes (${alma.governance.actionTypes.join(", ")})`);
  }
  if (command === "review" && !alma.governance.humanDecides?.includes("vote")) {
    throw new AlmaRefusal("alma.yaml does not reserve `vote` to a person (governance.humanDecides): refusing to record a vote decision");
  }
  if (command === "publish" && ctx.includeUndecided && (alma.governance.publish ?? "after-decision") === "after-decision") {
    throw new AlmaRefusal("alma.yaml publishes analyses after the decision: --all (undecided analyses) is not allowed");
  }
}

export async function loadAgentSigner(alma: AgentAlma): Promise<LocalSigner> {
  if (!existsSync(alma.keyFile)) throw new AlmaRefusal(`no signing key at ${alma.keyFile}: run \`alma connect\``);
  return LocalSigner.fromPkcs8(new Uint8Array(readFileSync(alma.keyFile)));
}

/** The issuer name the agent signs its own records as, the same convention alma-cli uses for self-attested history. */
export const selfIssuer = (almaId: string) => `self:${almaId}`;

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}
