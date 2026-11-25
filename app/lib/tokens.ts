export type Token = {
  symbol: string;
  contractId: string;
  decimals: number;
  classic?: { code: string; issuer: string };
};

export const TOKENS: Token[] = [
  {
    symbol: "XLM",
    contractId: process.env.NEXT_PUBLIC_TOKEN_XLM_ID ?? "",
    decimals: 7,
  },
  {
    symbol: "USDC",
    contractId: process.env.NEXT_PUBLIC_TOKEN_USDC_ID ?? "",
    decimals: 7,
    classic: {
      code: "USDC",
      issuer: process.env.NEXT_PUBLIC_USDC_ISSUER ?? "",
    },
  },
];

export const tokenById = (id: string) =>
  TOKENS.find((token) => token.contractId === id);
