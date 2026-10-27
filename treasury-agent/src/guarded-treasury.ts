import { FilePaymentStore, type Agent as SdkAgent, type FindPayment, type GuardedWallet, type Paid, type SendPayment } from "@adasouls/sdk";

/**
 * The treasury agent paying from its own wallet, through the SDK's
 * guarded wallet: AdaSouls authorizes each payment first, and the wallet
 * sends exactly what was authorized.
 *
 * The payment records go to a FilePaymentStore, never the in-memory
 * default: this agent runs unattended, and a restart between sending and
 * reporting would otherwise pay the vendor a second time. Each record is
 * on disk before the transfer is sent, so a restarted process reports or
 * reconciles a payment it already started instead of sending it again.
 */
export interface GuardedTreasuryDeps {
  /** The one place the signer is used. */
  send: SendPayment;
  /** Where payment records live. Keep it on a local disk, and keep it across deploys. */
  paymentsDir: string;
  /** Optional: finds a transfer a crash left in doubt (e.g. by scanning the token's Transfer events). */
  findPayment?: FindPayment;
}

export function buildGuardedTreasury(agent: SdkAgent, deps: GuardedTreasuryDeps): GuardedWallet {
  return agent.guardedWallet(deps.send, { store: new FilePaymentStore(deps.paymentsDir), findPayment: deps.findPayment });
}

/**
 * Pays the vendor from the agent's own wallet. `runId` names this
 * payment: rerunning with the same one (after a crash, a timeout, a
 * deploy) gets the same economic action back from the API, which the
 * wallet then finishes instead of paying again.
 */
export async function payVendorFromWallet(wallet: GuardedWallet, vendorAgentId: string, runId: string, amount = "500"): Promise<Paid> {
  return wallet.pay({
    amount,
    asset: "USDC",
    // Only the id: AdaSouls fills in where the vendor's owner is paid.
    counterparty: { id: vendorAgentId },
    idempotencyKey: `treasury:${runId}`,
  });
}
