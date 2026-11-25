import { Keypair, TransactionBuilder, Operation, Asset } from "@stellar/stellar-sdk";
import { cfg } from "./config";
import { addrVal, readCall, server, sendAndWait } from "./stellar";
import type { Token } from "./tokens";

export interface Wallet {
  kind: "freighter" | "demo";
  address: string;
  sign(transactionXdr: string): Promise<string>;
}

export async function connectFreighter(): Promise<Wallet> {
  const freighter = await import("@stellar/freighter-api");
  const connection = await freighter.isConnected();
  if (connection.error || !connection.isConnected) {
    throw new Error(
      "Freighter isn’t installed. Install it, or use a demo account.",
    );
  }

  const network = await freighter.getNetwork();
  if (network.error) {
    throw new Error(network.error.message ?? "Could not read the wallet network.");
  }
  if (network.networkPassphrase !== cfg.passphrase) {
    throw new Error("Switch Freighter to Stellar Testnet and try again.");
  }

  const access = await freighter.requestAccess();
  if (access.error) {
    throw new Error(access.error.message ?? "Wallet access was not granted.");
  }

  return {
    kind: "freighter",
    address: access.address,
    async sign(transactionXdr) {
      const signed = await freighter.signTransaction(transactionXdr, {
        networkPassphrase: cfg.passphrase,
        address: access.address,
      });
      if (signed.error) {
        throw new Error(signed.error.message ?? "Transaction signing failed.");
      }
      return signed.signedTxXdr;
    },
  };
}

function fromKeypair(keypair: Keypair): Wallet {
  return {
    kind: "demo",
    address: keypair.publicKey(),
    async sign(transactionXdr) {
      const transaction = TransactionBuilder.fromXDR(
        transactionXdr,
        cfg.passphrase,
      );
      transaction.sign(keypair);
      return transaction.toXDR();
    },
  };
}

export async function friendbot(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(
      "The test-network faucet is busy. Try again in a moment.",
    );
  }
}

export async function createDemoWallet(): Promise<Wallet> {
  const keypair = Keypair.random();
  await friendbot(keypair.publicKey());
  sessionStorage.setItem("jovo.demo", keypair.secret());
  return fromKeypair(keypair);
}

export function restoreDemoWallet(): Wallet | null {
  const secret = sessionStorage.getItem("jovo.demo");
  return secret ? fromKeypair(Keypair.fromSecret(secret)) : null;
}

export async function newReceiverWallet(
  classic?: { code: string; issuer: string },
): Promise<Keypair> {
  const keypair = Keypair.random();
  await friendbot(keypair.publicKey());

  if (classic) {
    const transaction = new TransactionBuilder(
      await server.getAccount(keypair.publicKey()),
      { fee: "10000", networkPassphrase: cfg.passphrase },
    )
      .addOperation(
        Operation.changeTrust({
          asset: new Asset(classic.code, classic.issuer),
        }),
      )
      .setTimeout(60)
      .build();
    transaction.sign(keypair);
    await sendAndWait(transaction.toXDR());
  }

  return keypair;
}

export async function readBalance(
  wallet: Wallet,
  token: Token,
): Promise<bigint> {
  if (!token.contractId) {
    throw new Error(`${token.symbol} is not configured for this deployment.`);
  }
  const result = await readCall(wallet.address, token.contractId, "balance", [
    addrVal(wallet.address),
  ]);
  if (
    typeof result !== "bigint" &&
    typeof result !== "number" &&
    typeof result !== "string"
  ) {
    throw new Error("Unexpected token balance returned by Stellar.");
  }
  return BigInt(result);
}
