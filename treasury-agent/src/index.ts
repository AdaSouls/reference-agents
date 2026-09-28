import "dotenv/config";
import { buildTreasuryAgent, describeAgent, putIdleTreasuryToWork } from "./treasury-agent.js";

const apiKey = process.env.ADASOULS_API_KEY;
const agentId = process.env.AGENT_ID;
const baseUrl = process.env.ADASOULS_API_URL;
// Must be a registered agent with real history for the counterparty policy
// to pass (e.g. ADASOULS_TEST_VENDOR_ID from adasouls-api's
// create-treasury-agent-test-fixture); the default is rejected by design.
const vendorAgentId = process.env.VENDOR_AGENT_ID ?? "agent_demo_vendor";

if (!apiKey || !agentId) {
  console.error("ADASOULS_API_KEY and AGENT_ID are required -- run `npm run setup` first, see README.md.");
  process.exit(1);
}

const agent = buildTreasuryAgent({ apiKey, agentId, baseUrl });

console.log(`Treasury Agent (${agentId}) putting 500 USDC of idle treasury to work...`);
const result = await putIdleTreasuryToWork(agent, vendorAgentId);
console.log("EconomicAction:", result);

console.log("\nAgent summary:");
const summary = await describeAgent(agent);
console.log(JSON.stringify(summary, null, 2));
