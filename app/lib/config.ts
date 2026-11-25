const configuredMaxAmount = process.env.NEXT_PUBLIC_MAX_LINK_AMOUNT || "1000";
if (!/^[1-9]\d*$/.test(configuredMaxAmount)) {
  throw new Error("NEXT_PUBLIC_MAX_LINK_AMOUNT must be a positive integer.");
}

export const cfg = {
  rpcUrl:
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL ??
    "https://soroban-testnet.stellar.org",
  passphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015",
  escrowId: process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ?? "",
  explorer: "https://stellar.expert/explorer/testnet",
  maxLinkAmount: BigInt(configuredMaxAmount),
};
