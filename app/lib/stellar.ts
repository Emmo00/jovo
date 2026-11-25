import { Buffer } from "buffer";
import {
  Address,
  BASE_FEE,
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { cfg } from "./config";

export const server = new rpc.Server(cfg.rpcUrl);
export const bytesVal = (bytes: Uint8Array) =>
  xdr.ScVal.scvBytes(Buffer.from(bytes));
export const addrVal = (address: string) => new Address(address).toScVal();

export async function prepareCall(
  source: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
) {
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  return server.prepareTransaction(transaction);
}

export async function readCall(
  source: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
) {
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);

  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error("Stellar transaction simulation failed.");
  }
  return scValToNative(simulation.result.retval);
}

export async function sendAndWait(signedXdr: string): Promise<string> {
  const transaction = TransactionBuilder.fromXDR(signedXdr, cfg.passphrase);
  const response = await server.sendTransaction(transaction);
  if (response.status === "ERROR") {
    throw new Error("Stellar transaction was rejected.");
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await server.getTransaction(response.hash);
    if (result.status === "SUCCESS") return response.hash;
    if (result.status === "FAILED") {
      throw new Error("Stellar transaction failed on-chain.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out waiting for Stellar transaction confirmation.");
}
