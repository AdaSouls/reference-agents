import "dotenv/config";

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

const { organization, principal } = await call<{ organization: { id: string }; principal: { id: string } }>(
  "/organizations",
  { name: `Treasury Agent Demo ${new Date().toISOString()}` }
);

const agent = await call<{ id: string }>("/agents", {
  organizationId: organization.id,
  principalId: principal.id,
  displayName: "Treasury Agent",
});

// Self policy: the treasury's own risk tolerance. 1000 USDC max per
// transaction, no human-approval threshold below that -- the "put 500
// USDC to work" scenario clears this outright (status "authorized", not
// "pending_approval").
await call("/policies", { organizationId: organization.id, kind: "self", rules: { maxTransaction: { USDC: "1000" } } });

// Counterparty policy: only pay counterparties with at least 1 prior
// completed transaction -- demonstrates the counterparty-trust check is
// real, not just self policy. src/treasury-agent.ts passes a
// counterparty context that satisfies this for the demo's vendor.
await call("/policies", { organizationId: organization.id, kind: "counterparty", rules: { minCompletedTransactions: 1 } });

const delegation = await call<{ id: string }>("/delegations", {
  issuer: principal.id,
  subject: agent.id,
  scope: { capabilities: ["pay"] },
});

const apiKey = await call<{ key: string }>(`/organizations/${organization.id}/api-keys`, { label: "treasury-agent" });

console.log("Setup complete. Add these to treasury-agent's .env:\n");
console.log(`ADASOULS_API_URL=${apiUrl}`);
console.log(`ADASOULS_API_KEY=${apiKey.key}`);
console.log(`AGENT_ID=${agent.id}`);
console.log(`\n(delegation ${delegation.id} grants "pay"; organization ${organization.id})`);
