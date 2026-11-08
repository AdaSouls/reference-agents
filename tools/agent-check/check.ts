#!/usr/bin/env -S npx tsx
/**
 * agent-check: the machine-checkable half of reference-agents/STANDARD.md.
 *
 *   npx tsx ../tools/agent-check/check.ts <agent-dir> [--no-subprocess] [--json]
 *
 * Every check names the rule it enforces. A check either passes, fails, or
 * is skipped with a reason (a skip is never silent). Exit 1 on any failure.
 * The point is that "this agent follows the standard" is something CI
 * says, not the author.
 *
 * Checks that need the network (npm audit) or the agent's own code (tests,
 * eval replay) run as subprocesses and can be turned off with
 * --no-subprocess for a quick local pass.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseManifestYaml } from "@adasouls/alma-manifest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";

export type Verdict = { id: string; rule: string; status: "pass" | "fail" | "skip"; detail?: string };

interface Ctx {
  dir: string;
  tracked: string[];
  subprocess: boolean;
}

const read = (dir: string, file: string) => readFileSync(path.join(dir, file), "utf8");
const exists = (dir: string, file: string) => existsSync(path.join(dir, file));

function gitTracked(dir: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

type Check = (ctx: Ctx) => Verdict | Promise<Verdict>;

const pass = (id: string, rule: string, detail?: string): Verdict => ({ id, rule, status: "pass", detail });
const fail = (id: string, rule: string, detail: string): Verdict => ({ id, rule, status: "fail", detail });
const skip = (id: string, rule: string, detail: string): Verdict => ({ id, rule, status: "skip", detail });

// ---------------------------------------------------------------- layout

const REQUIRED_FILES: Record<string, string> = {
  "README.md": "what it does, what it never does, how to run it",
  "alma.yaml": "the ALMA Agent Manifest",
  "agent.yaml": "profile: goal, scope, budgets",
  "escalation.yaml": "which decisions need a human",
  "security.md": "threat model",
  "context/sources.yaml": "every external source and how far it is trusted",
  ".env.example": "every variable, secrets without defaults",
  "package.json": "scripts: start, lint, build, test, check, eval",
  "package-lock.json": "pinned dependency tree",
  "CHANGELOG.md": "what changed in each version",
  "learning.md": "what may change without a new version",
};

const layout: Check = ({ dir }) => {
  const missing = Object.entries(REQUIRED_FILES).filter(([f]) => !exists(dir, f)).map(([f, why]) => `${f} (${why})`);
  for (const d of ["events/schemas", "src", "test", "test/fixtures", "prompts", "evals/cases"]) {
    if (!exists(dir, d) || !statSync(path.join(dir, d)).isDirectory()) missing.push(`${d}/`);
  }
  return missing.length ? fail("layout", "Layout", `missing: ${missing.join(", ")}`) : pass("layout", "Layout", `${Object.keys(REQUIRED_FILES).length} files, 6 directories`);
};

const scripts: Check = ({ dir }) => {
  const pkg = JSON.parse(read(dir, "package.json")) as { scripts?: Record<string, string> };
  const want = ["start", "lint", "build", "test", "check", "eval"];
  const missing = want.filter((s) => !pkg.scripts?.[s]);
  return missing.length ? fail("scripts", "Layout: package.json scripts", `missing scripts: ${missing.join(", ")}`) : pass("scripts", "Layout: package.json scripts");
};

// ---------------------------------------------------------------- manifest (rule: who the agent is, what it may do)

const MONEY_CAPABILITIES = ["pay", "transfer", "withdraw", "stake", "delegate", "vote", "sign"];

const manifest: Check = ({ dir }) => {
  let m;
  try {
    m = parseManifestYaml(read(dir, "alma.yaml"));
  } catch (err) {
    return fail("manifest", "The rule: alma.yaml is the agent", `alma.yaml does not parse: ${(err as Error).message.split("\n")[0]}`);
  }
  const caps = (m.capabilities ?? []) as string[];
  const money = caps.filter((c) => MONEY_CAPABILITIES.includes(c));
  const authority = (m as { authority?: { maxTransaction?: unknown; dailyLimit?: unknown } }).authority;
  if (money.length && !authority?.maxTransaction) {
    return fail("manifest", "The rule: value-moving capability needs a declared limit", `capabilities ${money.join(", ")} without authority.maxTransaction`);
  }
  if (caps.includes("vote")) {
    return fail("manifest", "The rule: an agent never votes", "capabilities include `vote`; a vote is a human's (escalation.yaml) or the mandate DRep's (agent_drep)");
  }
  return pass("manifest", "The rule: alma.yaml is the agent", `${m.metadata.name}: ${caps.join(", ") || "(no capabilities)"}`);
};

const escalation: Check = ({ dir }) => {
  let doc: { decisions?: Array<{ id?: string; decided_by?: { person?: string } }> };
  try {
    doc = parseYaml(read(dir, "escalation.yaml"));
  } catch (err) {
    return fail("escalation", "Rule 8: a human decides", `escalation.yaml does not parse: ${(err as Error).message}`);
  }
  const decisions = doc.decisions ?? [];
  const nameless = decisions.filter((d) => !d.decided_by?.person).map((d) => d.id ?? "?");
  if (!decisions.length) return fail("escalation", "Rule 8: a human decides", "no decisions listed");
  if (nameless.length) return fail("escalation", "Rule 8: a human decides", `decisions without a person: ${nameless.join(", ")}`);
  return pass("escalation", "Rule 8: a human decides", `${decisions.length} decisions, each with a person`);
};

// ---------------------------------------------------------------- secrets (rule 3)

const SECRET_VAR = /(KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|SEED)/i;

const envExample: Check = ({ dir }) => {
  const lines = read(dir, ".env.example").split("\n");
  const bad: string[] = [];
  for (const line of lines) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, name, value] = m;
    if (SECRET_VAR.test(name) && !/_FILE$/.test(name) && value.trim() !== "") bad.push(`${name} has a default`);
  }
  return bad.length ? fail("env", "Rule 3: secrets never have defaults", bad.join("; ")) : pass("env", "Rule 3: secrets never have defaults");
};

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["private key block", /-----BEGIN (?:EC |RSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Cardano signing key", /"cborHex"\s*:\s*"58(?:20|40)[0-9a-f]{64,}/],
  ["24-word mnemonic", /\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/],
];

const noSecrets: Check = ({ dir, tracked }) => {
  const hits: string[] = [];
  const files = tracked.length ? tracked : [];
  for (const f of files) {
    if (/\.(png|jpg|jpeg|gif|bin|woff2?|lock)$/.test(f)) continue;
    if (f === "package-lock.json") continue;
    let text: string;
    try {
      text = readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${f}: ${name}`);
  }
  if (tracked.some((f) => f === ".env" || f.startsWith(".alma/") || /\.skey$/.test(f) || f.endsWith("issuer.key"))) {
    hits.push("a .env, .alma/ or key file is tracked by git");
  }
  if (!tracked.length) return skip("secrets", "Rule 3: no secret in the repo", "not a git checkout; nothing scanned");
  return hits.length ? fail("secrets", "Rule 3: no secret in the repo", hits.join("; ")) : pass("secrets", "Rule 3: no secret in the repo", `${files.length} tracked files scanned`);
};

const securityDoc: Check = ({ dir }) => {
  const sec = read(dir, "security.md");
  const vars = read(dir, ".env.example")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=/.exec(l.trim())?.[1])
    .filter((v): v is string => !!v && SECRET_VAR.test(v));
  const missing = vars.filter((v) => !sec.includes(v));
  return missing.length
    ? fail("security-doc", "Layout: security.md names every key", `secrets not mentioned in security.md: ${missing.join(", ")}`)
    : pass("security-doc", "Layout: security.md names every key", vars.length ? vars.join(", ") : "no secret variables");
};

// ---------------------------------------------------------------- prompts (rule 5: versioned, so an analysis names what it ran)

const prompts: Check = ({ dir }) => {
  const files = readdirSync(path.join(dir, "prompts")).filter((f) => f.endsWith(".md"));
  const unversioned = files.filter((f) => !/\.v\d+\.md$/.test(f));
  if (unversioned.length) return fail("prompts", "Rule 5: prompts are versioned files", `not versioned: ${unversioned.join(", ")}`);
  const srcFiles = walk(path.join(dir, "src")).filter((f) => f.endsWith(".ts"));
  const refs = new Set<string>();
  for (const f of srcFiles) for (const m of readFileSync(f, "utf8").matchAll(/PROMPT_VERSION\s*=\s*"([^"]+)"/g)) refs.add(m[1]);
  if (!refs.size) return fail("prompts", "Rule 5: prompts are versioned files", "no PROMPT_VERSION constant in src/");
  const dangling = [...refs].filter((r) => !files.includes(`${r}.md`));
  return dangling.length
    ? fail("prompts", "Rule 5: prompts are versioned files", `PROMPT_VERSION ${dangling.join(", ")} has no prompts/<version>.md`)
    : pass("prompts", "Rule 5: prompts are versioned files", `${files.length} versions; code runs ${[...refs].join(", ")}`);
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---------------------------------------------------------------- events (rule 7: every event has a schema and a fixture that validates)

const events: Check = ({ dir }) => {
  const schemaDir = path.join(dir, "events", "schemas");
  const fixtureDir = path.join(dir, "events", "fixtures");
  const schemas = readdirSync(schemaDir).filter((f) => f.endsWith(".json"));
  if (!schemas.length) return fail("events", "Rule 7: every event has a JSON Schema", "events/schemas/ is empty");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const problems: string[] = [];
  let validated = 0;
  for (const file of schemas) {
    const schema = JSON.parse(readFileSync(path.join(schemaDir, file), "utf8")) as { $id?: string; title?: string };
    const name = file.replace(/\.json$/, "");
    if (!schema.$id || !schema.title) problems.push(`${file}: needs $id and title`);
    if (schema.title && schema.title !== name) problems.push(`${file}: title "${schema.title}" should equal the file name`);
    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      problems.push(`${file}: not a valid schema: ${(err as Error).message}`);
      continue;
    }
    const fixtures = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((f) => f.startsWith(`${name}.`) && f.endsWith(".json")) : [];
    if (!fixtures.length) {
      problems.push(`${file}: no fixture events/fixtures/${name}.*.json`);
      continue;
    }
    for (const fx of fixtures) {
      const ok = validate(JSON.parse(readFileSync(path.join(fixtureDir, fx), "utf8")));
      if (!ok) problems.push(`${fx}: ${ajv.errorsText(validate.errors)}`);
      else validated++;
    }
  }
  return problems.length ? fail("events", "Rule 7: every event has a JSON Schema and a validating fixture", problems.join("; ")) : pass("events", "Rule 7: every event has a JSON Schema and a validating fixture", `${schemas.length} schemas, ${validated} fixtures validate`);
};

// ---------------------------------------------------------------- tests offline (rule 6)

const testsOffline: Check = ({ dir }) => {
  const cfgFile = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js"].find((f) => exists(dir, f));
  if (!cfgFile) return fail("tests-offline", "Rule 6: tests never touch the network", "no vitest.config.* with a setup file that blocks fetch");
  const cfg = read(dir, cfgFile);
  const setup = /setupFiles:\s*\[?\s*["']([^"']+)["']/.exec(cfg)?.[1];
  if (!setup || !exists(dir, setup)) return fail("tests-offline", "Rule 6: tests never touch the network", `${cfgFile} has no setupFiles entry that exists`);
  const guard = read(dir, setup);
  if (!/globalThis\.fetch\s*=/.test(guard) || !/throw/.test(guard)) {
    return fail("tests-offline", "Rule 6: tests never touch the network", `${setup} does not replace globalThis.fetch with a thrower`);
  }
  return pass("tests-offline", "Rule 6: tests never touch the network", `${setup} blocks fetch unless LIVE_TESTS=1`);
};

// ---------------------------------------------------------------- evals (rule 5: behaviour pinned by cases)

const evals: Check = ({ dir }) => {
  const caseDir = path.join(dir, "evals", "cases");
  const cases = readdirSync(caseDir).filter((f) => f.endsWith(".json"));
  if (!cases.length) return fail("evals", "Rule 5: evals pin the agent's judgement", "evals/cases/ is empty");
  const problems: string[] = [];
  for (const c of cases) {
    const j = JSON.parse(readFileSync(path.join(caseDir, c), "utf8")) as { name?: string; expect?: unknown };
    if (!j.name || !j.expect) problems.push(`${c}: needs name and expect`);
    const recorded = path.join(dir, "evals", "recorded", c);
    if (!existsSync(recorded)) problems.push(`${c}: no recording in evals/recorded/ (run: npm run eval -- --record)`);
  }
  return problems.length ? fail("evals", "Rule 5: evals pin the agent's judgement", problems.join("; ")) : pass("evals", "Rule 5: evals pin the agent's judgement", `${cases.length} cases, all recorded`);
};

// ---------------------------------------------------------------- changelog + version

const changelog: Check = ({ dir }) => {
  const version = (JSON.parse(read(dir, "package.json")) as { version: string }).version;
  const log = read(dir, "CHANGELOG.md");
  return log.includes(`## ${version}`) || log.includes(`## [${version}]`)
    ? pass("changelog", "Layout: CHANGELOG.md names the current version", version)
    : fail("changelog", "Layout: CHANGELOG.md names the current version", `no "## ${version}" heading for package.json version`);
};

// ---------------------------------------------------------------- sources (rule 2: every external source declared)

const sources: Check = ({ dir }) => {
  let doc: { sources?: Array<{ name?: string; trust?: string }> };
  try {
    doc = parseYaml(read(dir, "context/sources.yaml"));
  } catch (err) {
    return fail("sources", "Rule 2: every source declared with its trust", `does not parse: ${(err as Error).message}`);
  }
  const list = doc.sources ?? [];
  const untrusted = list.filter((s) => !s.trust).map((s) => s.name ?? "?");
  if (!list.length) return fail("sources", "Rule 2: every source declared with its trust", "no sources listed");
  return untrusted.length ? fail("sources", "Rule 2: every source declared with its trust", `no trust statement: ${untrusted.join(", ")}`) : pass("sources", "Rule 2: every source declared with its trust", `${list.length} sources`);
};

// ---------------------------------------------------------------- subprocesses

function run(dir: string, cmd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" | ") };
}

const audit: Check = ({ dir, subprocess }) => {
  if (!subprocess) return skip("audit", "Supply chain: no known high/critical vulnerability", "--no-subprocess");
  const r = run(dir, "npm", ["audit", "--omit=dev", "--audit-level=high"]);
  if (!r.ok && /ENOTFOUND|EAI_AGAIN|network|audit endpoint/i.test(r.out)) return skip("audit", "Supply chain: no known high/critical vulnerability", "registry unreachable");
  return r.ok ? pass("audit", "Supply chain: no known high/critical vulnerability") : fail("audit", "Supply chain: no known high/critical vulnerability", r.out);
};

const evalReplay: Check = ({ dir, subprocess }) => {
  if (!subprocess) return skip("eval-replay", "Rule 5: recorded evals pass", "--no-subprocess");
  const r = run(dir, "npm", ["run", "--silent", "eval", "--", "--replay"]);
  return r.ok ? pass("eval-replay", "Rule 5: recorded evals pass", r.out) : fail("eval-replay", "Rule 5: recorded evals pass", r.out);
};

// ---------------------------------------------------------------- main

export const CHECKS: Check[] = [layout, scripts, manifest, escalation, envExample, noSecrets, securityDoc, prompts, events, testsOffline, evals, changelog, sources, audit, evalReplay];

export async function checkAgent(dir: string, options: { subprocess?: boolean } = {}): Promise<Verdict[]> {
  const ctx: Ctx = { dir: path.resolve(dir), tracked: gitTracked(dir), subprocess: options.subprocess ?? true };
  const out: Verdict[] = [];
  for (const c of CHECKS) {
    try {
      out.push(await c(ctx));
    } catch (err) {
      out.push({ id: c.name, rule: "(check crashed)", status: "fail", detail: (err as Error).message });
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) ?? ".";
  const verdicts = await checkAgent(dir, { subprocess: !args.includes("--no-subprocess") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(verdicts, null, 2));
  } else {
    for (const v of verdicts) {
      const mark = v.status === "pass" ? "ok  " : v.status === "skip" ? "skip" : "FAIL";
      console.log(`${mark}  ${v.id.padEnd(14)} ${v.rule}${v.detail ? `  — ${v.detail}` : ""}`);
    }
    const failed = verdicts.filter((v) => v.status === "fail").length;
    const skipped = verdicts.filter((v) => v.status === "skip").length;
    console.log(`\n${verdicts.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped — ${path.resolve(dir)}`);
  }
  process.exitCode = verdicts.some((v) => v.status === "fail") ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
