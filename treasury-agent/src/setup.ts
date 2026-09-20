import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseManifestYaml, compileManifest } from "@adasouls/alma-manifest";

/**
 * One-time admin bootstrap -- NOT part of the agent's own runtime, and
 * deliberately does not go through @adasouls/sdk: creating an
 * organization, agent, policies, a delegation, and an API key are all
 * human/admin actions in 06-api-contracts.md's model, not something the
 * public SDK surface covers (no adasouls-console exists yet either,
 * Phase 10). This is exactly what a human admin would do via raw REST
 * calls today -- calling adasouls-api's real HTTP API directly is not an
 * "internal shortcut" (reference-agents/REPOSITORY.md's non-
 * responsibility) since it's the real, documented public REST surface,
 * just not the part the SDK wraps yet.
 *
 * Since Phase 9: reads treasury-agent.yaml (the Agent Manifest) instead
 * of hardcoding the policy/delegation shape inline -- proves
 * `alma-manifest`'s Phase 9 exit criterion for real ("the Treasury
 * Agent's configuration can be expressed as, and reproduced from, a
 * manifest file") by actually driving this repo's own setup from it,
 * not just asserting shapes match in a unit test.
 *
 * Needs a real Auth0 access token (human/console-equivalent auth) --
 * get one the same way adasouls-api's own README documents for testing:
 *   curl -X POST https://<AUTH0_DOMAIN>/oauth/token \
 *     -H 'Content-Type: application/json' \
 *     -d '{"client_id":"...","client_secret":"...","audience":"<AUTH0_AUDIENCE>","grant_type":"client_credentials"}'
 * and export the resulting access_token as AUTH0_TOKEN below.
 */
const apiUrl = requireEnv("ADASOULS_API_URL");
const auth0Token = requireEnv("AUTH0_TOKEN");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required -- see src/setup.ts's header comment`);
  return value;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth0Token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const manifestPath = new URL("../treasury-agent.yaml", import.meta.url);
const manifest = parseManifestYaml(await readFile(manifestPath, "utf-8"));
const compiled = compileManifest(manifest);

const { organization, principal } = await call<{ organization: { id: string }; principal: { id: string } }>(
  "/organizations",
  { name: `${compiled.agent.displayName} Demo ${new Date().toISOString()}` }
);

const agent = await call<{ id: string }>("/agents", {
  organizationId: organization.id,
  principalId: principal.id,
  displayName: compiled.agent.displayName,
});

if (compiled.selfPolicy) {
  await call("/policies", { organizationId: organization.id, kind: compiled.selfPolicy.kind, rules: compiled.selfPolicy.rules });
}
if (compiled.counterpartyPolicy) {
  await call("/policies", {
    organizationId: organization.id,
    kind: compiled.counterpartyPolicy.kind,
    rules: compiled.counterpartyPolicy.rules,
  });
}

const delegation = await call<{ id: string }>("/delegations", {
  issuer: principal.id,
  subject: agent.id,
  scope: compiled.delegation.scope,
});

const apiKey = await call<{ key: string }>(`/organizations/${organization.id}/api-keys`, { label: "treasury-agent" });

console.log(`Setup complete from ${manifestPath.pathname}. Add these to treasury-agent's .env:\n`);
console.log(`ADASOULS_API_URL=${apiUrl}`);
console.log(`ADASOULS_API_KEY=${apiKey.key}`);
console.log(`AGENT_ID=${agent.id}`);
console.log(`\n(delegation ${delegation.id} grants ${compiled.delegation.scope.capabilities.join(", ")}; organization ${organization.id})`);
