import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { cfg } from "../lib/config";
import { linkIdOf, newSeed, signClaim } from "../lib/claim";
import { toUnits } from "../lib/amounts";
import { addrVal, bytesVal, prepareCall, readCall, sendAndWait, server } from "../lib/stellar";
import { friendbot } from "../lib/wallet";
import { readLink, relayClaim } from "../lib/server/relayer";

const XLM_ID = process.env.NEXT_PUBLIC_TOKEN_XLM_ID ?? "";
const FEE_TOLERANCE = BigInt(100_000);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asBigInt(value: unknown): bigint {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
    throw new Error("Unexpected token balance returned by Stellar.");
  }
  return BigInt(value);
}

async function tokenBalance(address: string): Promise<bigint> {
  const result = await readCall(address, XLM_ID, "balance", [addrVal(address)]);
  return asBigInt(result);
}

async function createLink(
  sender: Keypair,
  amount: bigint,
  expiresAt: number,
): Promise<{ linkId: Uint8Array; seed: Uint8Array }> {
  const seed = newSeed();
  const linkId = linkIdOf(seed);
  const transaction = await prepareCall(sender.publicKey(), cfg.escrowId, "create", [
    addrVal(sender.publicKey()),
    addrVal(XLM_ID),
    nativeToScVal(amount, { type: "i128" }),
    bytesVal(linkId),
    nativeToScVal(BigInt(expiresAt), { type: "u64" }),
  ]);
  transaction.sign(sender);
  await sendAndWait(transaction.toXDR());
  return { linkId, seed };
}

async function main() {
  const relayerSecret = process.env.RELAYER_SECRET;
  assert(Boolean(relayerSecret), "RELAYER_SECRET is required.");
  assert(Boolean(cfg.escrowId), "NEXT_PUBLIC_ESCROW_CONTRACT_ID is required.");
  assert(Boolean(XLM_ID), "NEXT_PUBLIC_TOKEN_XLM_ID is required.");

  const sender = Keypair.random();
  const recipient = Keypair.random();
  await Promise.all([friendbot(sender.publicKey()), friendbot(recipient.publicKey())]);

  const { linkId, seed } = await createLink(
    sender,
    toUnits("5"),
    Math.floor(Date.now() / 1000) + 3_600,
  );
  const linkIdHex = Buffer.from(linkId).toString("hex");
  assert(Boolean(await readLink(linkIdHex)), "The new link was not found on-chain.");

  const recipientBefore = await tokenBalance(recipient.publicKey());
  const signature = signClaim(seed, cfg.escrowId, recipient.publicKey());
  await relayClaim(
    linkIdHex,
    recipient.publicKey(),
    Buffer.from(signature).toString("hex"),
  );
  const recipientAfter = await tokenBalance(recipient.publicKey());
  assert(
    recipientAfter - recipientBefore === toUnits("5"),
    "The recipient did not receive exactly 5 XLM.",
  );
  assert((await readLink(linkIdHex)) === null, "The claimed link is still active.");

  const senderBeforeRefund = await tokenBalance(sender.publicKey());
  const latestLedger = await server.getLatestLedger();
  const ledgerTime = Math.floor(Date.parse(latestLedger.closeTime) / 1000);
  assert(Number.isFinite(ledgerTime), "Could not determine the current ledger time.");
  const { linkId: refundLink } = await createLink(
    sender,
    toUnits("1"),
    ledgerTime + 60,
  );
  const refundLinkHex = Buffer.from(refundLink).toString("hex");
  assert(Boolean(await readLink(refundLinkHex)), "The refund link was not found on-chain.");

  while (true) {
    const currentLedger = await server.getLatestLedger();
    const currentTime = Math.floor(Date.parse(currentLedger.closeTime) / 1000);
    if (currentTime >= ledgerTime + 60) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const refundTransaction = await prepareCall(
    sender.publicKey(),
    cfg.escrowId,
    "refund",
    [bytesVal(refundLink)],
  );
  refundTransaction.sign(sender);
  await sendAndWait(refundTransaction.toXDR());
  const senderAfterRefund = await tokenBalance(sender.publicKey());
  assert(
    senderAfterRefund >= senderBeforeRefund - FEE_TOLERANCE,
    "The sender’s XLM balance did not return after refund.",
  );
  assert((await readLink(refundLinkHex)) === null, "The refunded link is still active.");

  console.log("E2E OK");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "End-to-end test failed.");
  process.exitCode = 1;
});
