import { AdaSouls, type Agent as SdkAgent } from "@adasouls/sdk";

/**
 * The actual agent -- everything below this line talks to AdaSouls
 * through nothing but @adasouls/sdk, per reference-agents/REPOSITORY.md's
 * "zero internal shortcuts": if this needed something the SDK doesn't
 * expose, that would be an SDK gap to fix, not something to special-case
 * here. src/setup.ts (raw REST, real Auth0 token) is the one-time admin
 * bootstrap this agent assumes already happened -- it is not part of the
 * agent's own runtime.
 */
export interface TreasuryAgentDeps {
  apiKey: string;
  agentId: string;
  baseUrl?: string;
}

export interface TreasuryAgentResult {
  economicActionId: string;
  status: string;
  amount: string;
  asset: string;
  to: string;
}

export function buildTreasuryAgent(deps: TreasuryAgentDeps): SdkAgent {
  const adasouls = new AdaSouls({ apiKey: deps.apiKey, baseUrl: deps.baseUrl });
  return adasouls.agent(deps.agentId);
}

/**
 * The headline scenario: "put 500 USDC of idle treasury to work" --
 * pays a vendor, subject to whatever self/counterparty policy the org
 * configured (src/setup.ts's demo policies: max 1000 USDC per
 * transaction, counterparty needs >=1 prior completed transaction).
 * delegationId is intentionally omitted from the execute() call -- the
 * SDK resolves it from the agent's own active delegation.
 */
export async function putIdleTreasuryToWork(agent: SdkAgent, vendorAgentId: string): Promise<TreasuryAgentResult> {
  const handle = await agent.execute({
    capability: "pay",
    amount: "500",
    asset: "USDC",
    to: vendorAgentId,
    // Only the id: adasouls-api computes the vendor's record from receipts.
    counterparty: { id: vendorAgentId },
  });

  return { economicActionId: handle.action.id, status: handle.action.status, amount: "500", asset: "USDC", to: vendorAgentId };
}

/** Renders the audit trail a human/console would show for this agent -- identity, authority, and recent economic history, all from the public SDK. */
export async function describeAgent(agent: SdkAgent) {
  const [identity, authority, reputation, history] = await Promise.all([
    agent.identity(),
    agent.authority(),
    agent.reputation(),
    agent.history({ limit: 10 }),
  ]);
  return { identity, authority, reputation, history };
}
