# Jovo setup

This guide configures a local Jovo app on Stellar Testnet. It does not deploy the web app to Vercel or require access to a Vercel account.

## Prerequisites

- Node.js 20.9 or newer and Bun 1.4 or newer (or npm).
- Rust via rustup and the WebAssembly target:

  ```powershell
  rustup target add wasm32v1-none
  ```

- Stellar CLI (`cargo install --locked stellar-cli`) and a working `stellar --version`.
- On Windows, Visual Studio C++ Build Tools with the MSVC linker installed. Run Rust build/test commands from a Visual Studio Developer PowerShell or a shell initialized with the x64 C++ build environment.
- Docker Desktop for the local MongoDB container, or a reachable MongoDB instance.
- Git Bash on Windows if you will run `scripts/deploy.sh`.

The app and CLI commands in this guide are restricted to Stellar Testnet. Do not configure a mainnet endpoint.

## Clone, install, and configure local MongoDB

From PowerShell:

```powershell
git clone https://github.com/Emmo00/jovo.git
Set-Location jovo
Set-Location app
bun install
Copy-Item ..\.env.example .env.local
Set-Location ..
docker compose up -d
```

`.env.local` is in the Next.js project root (`app/`) and is ignored by git. Keep its values private. Docker Compose stores local database files in the `mongo_data` volume.

## Test and deploy the escrow contract

Run the local contract tests from the repository root:

```powershell
cargo test --manifest-path contracts\escrow\Cargo.toml
```

Generate and fund a testnet deployer identity, then build and deploy the contract from `app/`:

```powershell
stellar keys generate deployer --network testnet --fund
Set-Location app
npm run contract:deploy
```

On Windows, run `npm run contract:deploy` from Git Bash so `bash` resolves to Git for Windows. The script prints the public `ESCROW_CONTRACT_ID`; copy that ID into `NEXT_PUBLIC_ESCROW_CONTRACT_ID` in `app/.env.local`.

## Get the Stellar Asset Contract IDs

Get the native XLM SAC ID:

```powershell
Set-Location ..
stellar contract id asset --asset native --network testnet
```

Get the USDC SAC ID using Circle’s **current testnet issuer** (verify it against [Circle’s Stellar USDC documentation](https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-stellar)):

```powershell
stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet
```

If a token SAC is not deployed on Testnet, deploy it with the funded deployer:

```powershell
stellar contract asset deploy --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --source deployer --network testnet
```

Put the resulting IDs in `NEXT_PUBLIC_TOKEN_XLM_ID` and `NEXT_PUBLIC_TOKEN_USDC_ID` in `app/.env.local`. The test USDC issuer is already set in `.env.example`.

## Create and configure the relayer

The relayer signs claim transactions and pays their fees. Keep its funded balance small and use a testnet-only identity:

```powershell
stellar keys generate relayer --network testnet --fund
Set-Location app
$secret = (stellar keys secret relayer | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($secret)) { throw "Could not read the relayer key." }
$envPath = (Resolve-Path .env.local).Path
$lines = [System.IO.File]::ReadAllLines($envPath)
$updatedLines = foreach ($line in $lines) {
  if ($line.StartsWith("RELAYER_SECRET=")) { "RELAYER_SECRET=$secret" } else { $line }
}
[System.IO.File]::WriteAllLines($envPath, [string[]]$updatedLines, [System.Text.UTF8Encoding]::new($false))
Remove-Variable secret,lines,updatedLines,envPath
```

The PowerShell command captures the key in memory and writes it directly to the ignored environment file without echoing it. Never paste the secret into chat, source code, logs, or git.

Set `MONGODB_URI` to `mongodb://localhost:27017` for the local Docker database. Keep `MONGODB_DB=jovo`. Set `MAX_LINK_AMOUNT` and `NEXT_PUBLIC_MAX_LINK_AMOUNT` to the same positive integer; the latter is public and the current cap is a client-side guard. Keep `NEXT_PUBLIC_STELLAR_RPC_URL` and `NEXT_PUBLIC_NETWORK_PASSPHRASE` on Testnet.

## Verify the setup and run Jovo

From `app/`:

```powershell
npm run verify:message
npm run dev
```

`verify:message` compares the browser’s local claim-message encoding with the deployed contract. Visit `http://localhost:3000/send`, connect Freighter on Testnet or choose a demo account, select XLM or USDC, choose an expiry, review, and create a link. Copy the full link and open it in a private window to claim. For USDC, first obtain testnet USDC from the [Circle faucet](https://faucet.circle.com).

Run the full testnet integration script from `app/` when configured; it funds temporary test accounts with Friendbot, claims a 5 XLM payment, and waits for a one-minute link to expire before refunding it:

```powershell
npm run e2e
```

Other useful checks:

```powershell
npm run contract:test
npm run lint
npm run build
```

For manual QA, also reopen a claimed link, tamper with a test link fragment, confirm a non-expired refund button is hidden, verify that an expired link can be refunded, and check the screens at phone width.

## Troubleshooting

- **Freighter is on the wrong network:** switch the extension to Stellar Testnet, reconnect, and approve the testnet transaction. Jovo checks the wallet's network passphrase before using it.
- **`Buffer is not defined`:** the app imports the `buffer` package where browser code needs it. In custom client code, use `import { Buffer } from "buffer"` rather than relying on a Node.js global.
- **Missing USDC trustline:** a classic USDC account needs a trustline before it can receive USDC. Use “Create a wallet for me” to create a testnet account and establish its trustline, or add the trustline to an existing account before claiming.
- **Expired contract storage:** persistent contract entries can be archived after their TTL. The app has no restore screen. A Soroban `restore` transaction is required before the entry can be accessed again; use `stellar contract restore --help` and the correct persistent storage key XDR. Do not assume the payment is claimable or refundable until restoration succeeds.
- **RPC rate limits:** wait and retry, avoid rapid refreshes, and use a reliable Testnet RPC provider if the public endpoint is busy.
- **Friendbot failures:** the public faucet can be rate-limited or temporarily unavailable. Retry later, avoid repeatedly creating accounts, and make sure the address is a valid testnet key.
- **MongoDB connection failures:** ensure Docker Desktop is running and `docker compose up -d` completed, or check the `MONGODB_URI` value for the database you intend to use.
- **Contract tests fail with `link.exe` missing on Windows:** install Visual Studio C++ Build Tools and run cargo commands from its x64 Developer PowerShell.
