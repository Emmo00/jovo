# Jovo

Jovo lets a sender lock XLM or USDC in a Soroban escrow and share a private claim link. The recipient can claim to any Stellar address while the relayer pays the transaction fee, or the sender can refund after expiry.

## Architecture

```text
Sender (browser)              Soroban escrow contract             Recipient (browser)       Next.js API + relayer
 create(link_id=pubkey) ────► holds tokens, stores Link ◄────── claim(sig over `to`) ────► relayer pays fee
 link = /c/<id>#<seed>         verifies Ed25519 signature                                  MongoDB: history
```

The link identifier is an Ed25519 public key. Its 32-byte seed stays in the URL fragment; browsers do not send fragments to the server.

## Features

- Create testnet XLM or USDC payment links with 1-, 7-, or 30-day expiry.
- Connect Freighter or use a temporary, testnet-funded demo wallet.
- Claim without XLM for fees using the server-side relayer.
- Create a recipient wallet with the required USDC trustline.
- Refund an unclaimed payment after expiry.
- View link history and live on-chain status in the dashboard.

## Technology

- Next.js 16 App Router, React, TypeScript, and Bricolage Grotesque.
- Stellar SDK and Freighter API for Soroban RPC, signatures, and wallet transactions.
- Soroban escrow contract written in Rust with `soroban-sdk`.
- MongoDB for link history and per-IP claim rate limits.
- Vercel for the web app and serverless API routes.

## Project structure

```text
.
├── app/                         # Case A: full Next.js project and Vercel root
│   ├── app/                     # App Router pages and API routes
│   ├── components/              # Send, claim, dashboard, and modal UI
│   ├── lib/                     # Stellar, wallet, and server helpers
│   ├── scripts/                 # Integration verification scripts
│   └── package.json
├── contracts/escrow/            # Soroban workspace and jovo-escrow crate
├── scripts/deploy.sh            # Testnet-only contract deployment
├── docker-compose.yml           # Local MongoDB
├── .env.example                 # Safe environment template (no secrets)
├── README.md
└── SETUP.md
```

## Quick start

From the repository root:

```powershell
Set-Location app
bun install
bun run dev
```

Open `http://localhost:3000`. To use wallet and API flows, first complete [SETUP.md](./SETUP.md) and configure testnet contract IDs, a relayer, and MongoDB. `npm run` can be used instead of `bun run` for the app scripts.

## Environment variables

Create `app/.env.local` from `.env.example`. The `NEXT_PUBLIC_*` variables are included in browser bundles and are not secrets.

| Name | Purpose | Sensitive |
|---|---|---|
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Stellar testnet Soroban RPC endpoint | No |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Stellar testnet transaction/signature passphrase | No |
| `NEXT_PUBLIC_ESCROW_CONTRACT_ID` | Deployed escrow contract ID | No |
| `NEXT_PUBLIC_TOKEN_XLM_ID` | Native XLM Stellar Asset Contract ID | No |
| `NEXT_PUBLIC_TOKEN_USDC_ID` | USDC Stellar Asset Contract ID | No |
| `NEXT_PUBLIC_USDC_ISSUER` | Circle testnet USDC issuer | No |
| `NEXT_PUBLIC_MAX_LINK_AMOUNT` | Client-visible maximum amount in token units | No |
| `RELAYER_SECRET` | Testnet account secret used to sponsor claim transactions | **Yes** |
| `MONGODB_URI` | MongoDB connection string | **Yes** |
| `MONGODB_DB` | MongoDB database name | No |
| `MAX_LINK_AMOUNT` | Server-side deployment setting retained for configuration parity | No |

Keep `MAX_LINK_AMOUNT` and `NEXT_PUBLIC_MAX_LINK_AMOUNT` equal. The current amount limit is a client-side guard; the escrow contract does not impose a separate limit.

## Claim signature

The browser signs the exact concatenation `jovo-claim-v1 || link_id || contract_xdr || destination_xdr` with the one-time Ed25519 key from the link fragment. The Soroban contract verifies the signature against the public key in `link_id`. Including both the escrow contract and destination prevents a relayer or link observer from redirecting the payment.

## Security model and known limits

- A full claim URL is a bearer secret. Anyone who obtains it can claim the funds; share it privately.
- The seed is only in the URL fragment and browser memory. It is not sent to an API, logged, or stored in MongoDB.
- The relayer is a hot wallet. Keep only a small testnet XLM balance in it; the in-process queue does not coordinate across Vercel instances.
- Claim requests are limited to 10 per minute per IP using MongoDB. Tune this before any real use.
- Link status is inferred from chain state and MongoDB history. A claim sent by an unrelated relayer may be displayed as refunded.
- The 30-day maximum follows Soroban persistent-storage limits. Archived entries may need a Soroban `restore` transaction; the app does not currently provide a restore UI.
- The amount limit is enforced in the UI only, not by the contract.
- Classic USDC requires a recipient trustline. “Create a wallet for me” creates one, but an existing recipient wallet must already have it.
- The contract is unaudited and testnet-only. Do not use it with real funds.
- Throughput is intentionally low. Production use needs relayer channel accounts, durable queues, stronger operational monitoring, and security review.

## Decisions

- **Repository layout: Case A.** `app/` already contains a complete Next.js project, so the contract remains at the repository root and Vercel's Root Directory is `app`.
- **Next.js 16 Cache Components.** The starter enables Cache Components. Its current Next.js documentation disallows `runtime` route exports and replaces `dynamic = "force-dynamic"` with request-time data access. API routes therefore rely on the default Node.js runtime and request/database data; the dynamic claim route awaits `params` under Suspense.
- **Browser amount configuration.** Next.js only exposes `NEXT_PUBLIC_*` variables to client code, so `NEXT_PUBLIC_MAX_LINK_AMOUNT` is used by the send screen alongside `MAX_LINK_AMOUNT`.
- **No deployments or secrets committed.** Contract deployment, Vercel configuration, and testnet end-to-end checks require local credentials, environment values, and user-controlled services. They were not performed as part of this source-only build.

## Deploying to Vercel

1. Create a MongoDB Atlas database and database user, and configure network access for the Vercel deployment. Docker Compose is for local development only.
2. Deploy the testnet escrow contract and create/fund the relayer before configuring the app.
3. Add every variable listed in `.env.example` to the required Vercel environments. Mark `RELAYER_SECRET` and `MONGODB_URI` as sensitive. Do not set example blanks as real values.
4. Set the Vercel **Root Directory** to `app` (Case A). The project retains the existing Next.js configuration.
5. `NEXT_PUBLIC_*` values are inlined at build time; redeploy after changing one.
6. After the account owner deploys, smoke-test: create a link with a demo wallet, claim it in a private window, and confirm the dashboard status.

The claim endpoint has `maxDuration = 60`. If the Vercel plan limit is lower, lower the duration and update the claim UX to poll `GET /api/links/[id]` for the final status instead of waiting synchronously. This repository does not deploy to or modify a Vercel account.

## License

MIT License. See [LICENSE](./LICENSE).
