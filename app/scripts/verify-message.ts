import { Keypair } from "@stellar/stellar-sdk";
import { cfg } from "../lib/config";
import { claimMessage, linkIdOf, newSeed, toHex } from "../lib/claim";
import { addrVal, bytesVal, readCall } from "../lib/stellar";

async function main() {
  const secret = process.env.RELAYER_SECRET;
  if (!secret) throw new Error("RELAYER_SECRET is required.");
  if (!cfg.escrowId) {
    throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT_ID is required.");
  }

  const source = Keypair.fromSecret(secret).publicKey();
  const destination = Keypair.random().publicKey();
  const linkId = linkIdOf(newSeed());
  const onChain = await readCall(source, cfg.escrowId, "claim_message", [
    bytesVal(linkId),
    addrVal(destination),
  ]);
  if (!(onChain instanceof Uint8Array)) {
    throw new Error("The contract returned an invalid claim message.");
  }

  const local = claimMessage(linkId, cfg.escrowId, destination);
  if (toHex(onChain) !== toHex(local)) {
    throw new Error("Claim message encoding does not match the contract.");
  }
  console.log("claim message encoding matches");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Message verification failed.");
  process.exitCode = 1;
});
