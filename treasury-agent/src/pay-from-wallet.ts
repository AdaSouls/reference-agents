import "dotenv/config";
import { erc20Transfer } from "@adasouls/sdk";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { buildTreasuryAgent } from "./treasury-agent.js";
import { buildGuardedTreasury, payVendorFromWallet } from "./guarded-treasury.js";

/**
 * The treasury agent paying from its own wallet (Base Sepolia USDC),
 * for an agent whose wallet is connected in "self" mode. Safe to run
 * again with the same PAYMENT_RUN_ID after it stops at any point: the
 * payment record in PAYMENTS_DIR keeps it from paying twice.
 */
const apiKey = process.env.ADASOULS_API_KEY;
const agentId = process.env.AGENT_ID;
const privateKey = process.env.AGENT_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const vendorAgentId = process.env.VENDOR_AGENT_ID ?? "agent_demo_vendor";
const paymentsDir = process.env.PAYMENTS_DIR ?? ".adasouls/payments";
const runId = process.env.PAYMENT_RUN_ID ?? new Date().toISOString().slice(0, 10);

if (!apiKey || !agentId || !privateKey) {
  console.error("ADASOULS_API_KEY, AGENT_ID and AGENT_WALLET_PRIVATE_KEY are required -- see README.md.");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const signer = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });

const agent = buildTreasuryAgent({ apiKey, agentId, baseUrl: process.env.ADASOULS_API_URL });
// The signer is used here and nowhere else: the agent's code only ever sees the guarded wallet.
const wallet = buildGuardedTreasury(agent, {
  send: async (payment) => {
    const call = erc20Transfer(payment);
    return signer.sendTransaction({ to: call.to, data: call.data, value: call.value });
  },
  paymentsDir,
});

console.log(`Treasury Agent (${agentId}) paying ${vendorAgentId} from ${account.address}, run "${runId}"...`);
const paid = await payVendorFromWallet(wallet, vendorAgentId, runId);
console.log(`EconomicAction ${paid.action.id}: ${paid.action.status}, tx ${paid.txHash}`);
