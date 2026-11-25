import { Keypair } from "@stellar/stellar-sdk";
import { cfg } from "../config";
import { fromHex } from "../claim";
import { addrVal, bytesVal, prepareCall, readCall, sendAndWait } from "../stellar";

type OnChainLink = {
  sender: string;
  token: string;
  amount: string;
  expiresAt: number;
};

function relayer(): Keypair {
  const secret = process.env.RELAYER_SECRET;
  if (!secret) {
    throw new Error("RELAYER_SECRET is required to use the relayer.");
  }
  if (!cfg.escrowId) {
    throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT_ID is required.");
  }
  return Keypair.fromSecret(secret);
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

export async function readLink(linkIdHex: string): Promise<OnChainLink | null> {
  const key = relayer();
  const result = await readCall(key.publicKey(), cfg.escrowId, "get", [
    bytesVal(fromHex(linkIdHex)),
  ]);
  if (result === null) return null;

  if (
    typeof result !== "object" ||
    result === null ||
    !("sender" in result) ||
    !("token" in result) ||
    !("amount" in result) ||
    !("expires_at" in result)
  ) {
    throw new Error("Unexpected link data returned by the escrow contract.");
  }

  const link = result as Record<string, unknown>;
  if (
    typeof link.sender !== "string" ||
    typeof link.token !== "string" ||
    (typeof link.amount !== "number" && typeof link.amount !== "bigint") ||
    (typeof link.expires_at !== "number" &&
      typeof link.expires_at !== "bigint")
  ) {
    throw new Error("Unexpected link data returned by the escrow contract.");
  }

  return {
    sender: link.sender,
    token: link.token,
    amount: String(link.amount),
    expiresAt: Number(link.expires_at),
  };
}

export function relayClaim(
  linkIdHex: string,
  destination: string,
  signatureHex: string,
): Promise<string> {
  return serial(async () => {
    const key = relayer();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const transaction = await prepareCall(
          key.publicKey(),
          cfg.escrowId,
          "claim",
          [
            bytesVal(fromHex(linkIdHex)),
            addrVal(destination),
            bytesVal(fromHex(signatureHex)),
          ],
        );
        transaction.sign(key);
        return await sendAndWait(transaction.toXDR());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < 2 && /txBadSeq|bad.?seq/i.test(message)) continue;
        throw error;
      }
    }
  });
}
