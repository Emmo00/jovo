export const cfg = {
  rpcUrl:
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL ??
    "https://soroban-testnet.stellar.org",
  passphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015",
  escrowId: process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ?? "",
  explorer: "https://stellar.expert/explorer/testnet",
};
