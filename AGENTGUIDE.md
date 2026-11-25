# Jovo: Agent Build Guide

You are building **Jovo**, a pay-by-link app on Stellar testnet. A sender locks tokens in a **Soroban escrow contract** and gets a link. Whoever holds the link can claim the tokens to any address, with no XLM needed, because a backend **relayer** pays the fee. If nobody claims, the sender can refund after an expiry time.

Work through the phases in order. **Every phase ends with a CHECKPOINT. Do not continue until it passes.** Commit after each phase.

## Rules for you (the agent)

1. Never put secrets (`RELAYER_SECRET`, link seeds) in client code, logs, MongoDB or git.
2. Library versions move fast. Use the latest stable versions, and if an API in this guide doesn’t compile or run, check the official docs and fix it rather than working around it: `developers.stellar.org`, `docs.rs/soroban-sdk`, and the `_migrating` page of `soroban-sdk` for breaking changes.
3. Network is **testnet only**. Do not add mainnet config.
4. Keep the UI focused: **one task per screen**, modals only for quick decisions (see Phase 7).
5. Deployment target is **Vercel** (serverless). See Phase 10. Do not deploy or touch the Vercel account yourself; ask first if a preview deploy is needed.
6. If something is genuinely ambiguous, choose the simplest option, note it in `README.md` under “Decisions”, and continue.

## How it works

```
Sender (browser)            Soroban escrow contract           Recipient (browser)      Next.js API + relayer
 create(link_id=pubkey) ──►  holds tokens, stores Link   ◄──  claim(sig over `to`)  ──►  relayer pays fee
 link = /c/<id>#<seed>       claim: verify ed25519 sig                                    MongoDB: history
```

- `link_id` is the **ed25519 public key** of a one-time keypair. The 32-byte **seed** lives only in the URL fragment (`#...`), which browsers never send to servers.
- To claim, the recipient signs `domain || link_id || contract_xdr || to_xdr` with the link key. The contract verifies it with `ed25519_verify`. Because the signature covers the destination `to`, a relayer or snooper cannot redirect funds.
- Any SEP-41 token works: XLM and USDC via their Stellar Asset Contracts (SACs), or a Soroban-native token.
- **Trustline caveat:** classic assets like USDC still need the recipient’s G-account to exist and hold a trustline. The “Create a wallet for me” flow handles this.

## Phase 0: Prerequisites

Install and verify:

```bash
node -v          # >= 20.9
rustc --version  # via rustup
rustup target add wasm32v1-none   # if `stellar contract build` asks for another target, add that one
cargo install --locked stellar-cli
stellar --version
docker --version # optional, for local MongoDB
```

**CHECKPOINT:** all commands succeed.

## Phase 1: Repo layout

**The repo already contains a boilerplate Next.js app. Do not run `create-next-app`.** Inspect it first and note which case applies under “Decisions” in the README:

- **Case A:** `app/` is a full Next.js project (it has its own `package.json`). Treat it as the project root, keep `contracts/` at the repo root, adjust script paths, and set the Vercel **Root Directory** to `app`.
- **Case B:** `app/` is just the App Router folder of a project at the repo root. Use the layout below.

```
jovo/
  contracts/escrow/        # Soroban crate (Phase 2)
  app/                     # Next.js App Router pages and API routes (existing)
  components/  lib/  scripts/
  docker-compose.yml  .env.example  README.md  SETUP.md
```

Keep the existing Next.js version and config. Install dependencies into the existing project and adapt this guide’s code to its version:

```bash
npm i @stellar/stellar-sdk @stellar/freighter-api mongodb zod
npm i -D tsx
mkdir -p contracts lib/server components scripts
```

**CHECKPOINT:** `npm run dev` serves the default page.

## Phase 2: Smart contract

### 2.1 Scaffold

```bash
cd contracts
stellar contract init escrow --name jovo-escrow   # if flags differ: `stellar contract init --help`
```

Keep the scaffold’s `soroban-sdk` version. Rename the generated contract crate so the package name is `jovo-escrow` (wasm output `jovo_escrow.wasm`). Remove the hello-world code. In the crate’s `Cargo.toml` add:

```toml
[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }   # match how the scaffold declares it
ed25519-dalek = "2"
```

### 2.2 `src/lib.rs`

```rust
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, xdr::ToXdr, Address, Bytes, BytesN, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InvalidExpiry = 2,
    LinkExists = 3,
    LinkNotFound = 4,
    NotExpired = 5,
}

#[contracttype]
#[derive(Clone)]
pub struct Link {
    pub sender: Address,
    pub token: Address,
    pub amount: i128,
    pub expires_at: u64, // unix seconds; the sender may refund at or after this time
}

#[contracttype]
enum DataKey {
    Link(BytesN<32>), // link_id = ed25519 public key of the link keypair
}

fn build_message(env: &Env, link_id: &BytesN<32>, to: &Address) -> Bytes {
    let mut m = Bytes::from_slice(env, b"jovo-claim-v1");
    m.append(&Bytes::from_array(env, &link_id.to_array()));
    m.append(&env.current_contract_address().to_xdr(env));
    m.append(&to.clone().to_xdr(env));
    m
}

fn bump(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, max, max);
}

#[contract]
pub struct JovoEscrow;

#[contractimpl]
impl JovoEscrow {
    /// Lock `amount` of `token` from `sender` under `link_id`.
    pub fn create(
        env: Env,
        sender: Address,
        token: Address,
        amount: i128,
        link_id: BytesN<32>,
        expires_at: u64,
    ) -> Result<(), Error> {
        sender.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if expires_at <= env.ledger().timestamp() {
            return Err(Error::InvalidExpiry);
        }
        let key = DataKey::Link(link_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::LinkExists);
        }
        token::Client::new(&env, &token).transfer(&sender, &env.current_contract_address(), &amount);
        env.storage().persistent().set(&key, &Link { sender, token, amount, expires_at });
        bump(&env, &key);
        Ok(())
    }

    /// Anyone may submit this (e.g. a relayer). The signature must come from the link key and
    /// cover this contract and the destination `to`, so the funds cannot be redirected.
    pub fn claim(env: Env, link_id: BytesN<32>, to: Address, signature: BytesN<64>) -> Result<(), Error> {
        let key = DataKey::Link(link_id.clone());
        let link: Link = env.storage().persistent().get(&key).ok_or(Error::LinkNotFound)?;
        let msg = build_message(&env, &link_id, &to);
        env.crypto().ed25519_verify(&link_id, &msg, &signature); // traps if invalid
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &link.token).transfer(&env.current_contract_address(), &to, &link.amount);
        Ok(())
    }

    /// Sender takes the funds back once the link has expired and is still unclaimed.
    pub fn refund(env: Env, link_id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Link(link_id);
        let link: Link = env.storage().persistent().get(&key).ok_or(Error::LinkNotFound)?;
        link.sender.require_auth();
        if env.ledger().timestamp() < link.expires_at {
            return Err(Error::NotExpired);
        }
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &link.token).transfer(&env.current_contract_address(), &link.sender, &link.amount);
        Ok(())
    }

    pub fn get(env: Env, link_id: BytesN<32>) -> Option<Link> {
        env.storage().persistent().get(&DataKey::Link(link_id))
    }

    /// Anyone can extend a link’s storage lifetime.
    pub fn bump(env: Env, link_id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Link(link_id);
        if !env.storage().persistent().has(&key) {
            return Err(Error::LinkNotFound);
        }
        bump(&env, &key);
        Ok(())
    }

    /// Exposes the exact bytes the claimer must sign. Used to verify the TypeScript encoder matches.
    pub fn claim_message(env: Env, link_id: BytesN<32>, to: Address) -> Bytes {
        build_message(&env, &link_id, &to)
    }
}

#[cfg(test)]
mod test;
```

Compile-fix notes: if `transfer`’s `to` argument complains about `MuxedAddress`, pass `&to.clone().into()`. If a `soroban-sdk` API moved, consult the migration guide for the installed version. Do not add contract events; the backend records history in MongoDB.

### 2.3 `src/test.rs`

```rust
#![cfg(test)]
extern crate std;
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

fn setup(env: &Env) -> (JovoEscrowClient<'_>, TokenClient<'_>, Address, SigningKey, BytesN<32>) {
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &sac.address());
    let sender = Address::generate(env);
    StellarAssetClient::new(env, &sac.address()).mint(&sender, &1_000);
    let client = JovoEscrowClient::new(env, &env.register(JovoEscrow, ()));
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let link_id = BytesN::from_array(env, &key.verifying_key().to_bytes());
    client.create(&sender, &token.address, &500, &link_id, &2_000);
    (client, token, sender, key, link_id)
}

fn sign(env: &Env, client: &JovoEscrowClient, key: &SigningKey, id: &BytesN<32>, to: &Address) -> BytesN<64> {
    let msg = client.claim_message(id, to);
    let mut buf = std::vec![0u8; msg.len() as usize];
    msg.copy_into_slice(&mut buf);
    BytesN::from_array(env, &key.sign(&buf).to_bytes())
}

#[test]
fn create_then_claim_pays_recipient() {
    let env = Env::default();
    let (client, token, sender, key, id) = setup(&env);
    assert_eq!(token.balance(&sender), 500);
    let to = Address::generate(&env);
    client.claim(&id, &to, &sign(&env, &client, &key, &id, &to));
    assert_eq!(token.balance(&to), 500);
    assert!(client.get(&id).is_none());
}

#[test]
#[should_panic]
fn claim_signed_for_another_recipient_fails() {
    let env = Env::default();
    let (client, _t, _s, key, id) = setup(&env);
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    client.claim(&id, &b, &sign(&env, &client, &key, &id, &a));
}

#[test]
fn cannot_claim_twice() {
    let env = Env::default();
    let (client, _t, _s, key, id) = setup(&env);
    let to = Address::generate(&env);
    let sig = sign(&env, &client, &key, &id, &to);
    client.claim(&id, &to, &sig);
    assert!(client.try_claim(&id, &to, &sig).is_err());
}

#[test]
fn refund_only_after_expiry() {
    let env = Env::default();
    let (client, token, sender, _k, id) = setup(&env);
    assert_eq!(client.try_refund(&id), Err(Ok(Error::NotExpired)));
    env.ledger().set_timestamp(2_001);
    client.refund(&id);
    assert_eq!(token.balance(&sender), 1_000);
}
```

### 2.4 Build, test, deploy

```bash
cd contracts/escrow
cargo test
stellar contract build            # prints the wasm path
stellar keys generate deployer --network testnet --fund
```

Create `scripts/deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
NETWORK="${NETWORK:-testnet}"; SOURCE="${SOURCE:-deployer}"
cd "$(dirname "$0")/../contracts/escrow"
stellar contract build
WASM="$(ls target/wasm32*/release/jovo_escrow.wasm ../../target/wasm32*/release/jovo_escrow.wasm 2>/dev/null | head -n1)"
ID="$(stellar contract deploy --wasm "$WASM" --source "$SOURCE" --network "$NETWORK")"
echo "ESCROW_CONTRACT_ID=$ID"
```

Token contract IDs (SACs). XLM and USDC both need a deployed SAC on testnet:

```bash
stellar contract id asset --asset native --network testnet
# USDC: confirm the testnet issuer in Circle’s docs first; the issuer below is what I believe is current
stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet
# if invoking a SAC says "contract not found", deploy it:
stellar contract asset deploy --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --source deployer --network testnet
```

Relayer account (pays fees for claims):

```bash
stellar keys generate relayer --network testnet --fund
stellar keys secret relayer     # on older CLIs: `stellar keys show relayer`
```

**CHECKPOINT:** `cargo test` passes (4 tests); the contract is deployed and `stellar contract invoke --id $ESCROW_CONTRACT_ID --source deployer --network testnet -- get --link_id 0000000000000000000000000000000000000000000000000000000000000000` returns `null`.

## Phase 3: Environment and database

`.env.example` (copy to `.env.local`):

```bash
NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
NEXT_PUBLIC_ESCROW_CONTRACT_ID=
NEXT_PUBLIC_TOKEN_XLM_ID=
NEXT_PUBLIC_TOKEN_USDC_ID=
NEXT_PUBLIC_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
RELAYER_SECRET=
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=jovo
MAX_LINK_AMOUNT=1000
```

`docker-compose.yml`:

```yaml
services:
  mongo:
    image: mongo:7
    ports: ["27017:27017"]
    volumes: ["mongo_data:/data/db"]
volumes:
  mongo_data:
```

`lib/server/db.ts`:

```ts
import { MongoClient } from "mongodb";

const g = globalThis as unknown as { _mongo?: Promise<MongoClient> };
export async function db() {
  g._mongo ??= new MongoClient(process.env.MONGODB_URI!).connect();
  const d = (await g._mongo).db(process.env.MONGODB_DB ?? "jovo");
  await d.collection("links").createIndex({ sender: 1, createdAt: -1 });
  return d;
}

export type LinkDoc = {
  _id: string;            // link_id hex
  sender: string; token: string; amount: string; expiresAt: number;
  memo?: string; createTxHash: string; createdAt: Date;
  claimTxHash?: string; claimedBy?: string; claimedAt?: Date;
};
```

**CHECKPOINT:** `docker compose up -d` runs; env values are filled in.

## Phase 4: Shared libraries

`lib/config.ts`, `lib/tokens.ts`, `lib/amounts.ts`:

```ts
// lib/config.ts
export const cfg = {
  rpcUrl: process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
  passphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  escrowId: process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ?? "",
  explorer: "https://stellar.expert/explorer/testnet",
};

// lib/tokens.ts
export type Token = { symbol: string; contractId: string; decimals: number; classic?: { code: string; issuer: string } };
export const TOKENS: Token[] = [
  { symbol: "XLM", contractId: process.env.NEXT_PUBLIC_TOKEN_XLM_ID ?? "", decimals: 7 },
  { symbol: "USDC", contractId: process.env.NEXT_PUBLIC_TOKEN_USDC_ID ?? "", decimals: 7,
    classic: { code: "USDC", issuer: process.env.NEXT_PUBLIC_USDC_ISSUER ?? "" } },
];
export const tokenById = (id: string) => TOKENS.find((t) => t.contractId === id);

// lib/amounts.ts  (BigInt only; never floats)
export function toUnits(s: string, d = 7): bigint {
  const [w = "0", f = ""] = s.trim().split(".");
  if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f) || f.length > d) throw new Error("Invalid amount");
  return BigInt(w || "0") * BigInt(10) ** BigInt(d) + BigInt(f.padEnd(d, "0") || "0");
}
export function fromUnits(n: bigint | string, d = 7): string {
  const v = BigInt(n), base = BigInt(10) ** BigInt(d);
  const frac = (v % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}
```

`lib/claim.ts`: the link key and the exact bytes to sign (must match `build_message` in Rust):

```ts
import { Address, Keypair } from "@stellar/stellar-sdk";

const DOMAIN = Buffer.from("jovo-claim-v1");
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
export const toB64Url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const newSeed = () => crypto.getRandomValues(new Uint8Array(32));
export const linkKeypair = (seed: Uint8Array) => Keypair.fromRawEd25519Seed(Buffer.from(seed));
export const linkIdOf = (seed: Uint8Array) => Buffer.from(linkKeypair(seed).rawPublicKey());

export function claimMessage(linkId: Uint8Array, escrowId: string, to: string): Buffer {
  return Buffer.concat([
    DOMAIN,
    Buffer.from(linkId),
    new Address(escrowId).toScVal().toXDR(),
    new Address(to).toScVal().toXDR(),
  ]);
}
export function signClaim(seed: Uint8Array, escrowId: string, to: string): Buffer {
  const kp = linkKeypair(seed);
  return kp.sign(claimMessage(kp.rawPublicKey(), escrowId, to));
}
```

If the browser reports `Buffer is not defined`, add the `buffer` package and set `window.Buffer` in a client-only provider.

`lib/stellar.ts`: shared RPC helpers (client and server):

```ts
import { rpc, Contract, TransactionBuilder, BASE_FEE, xdr, Address, scValToNative } from "@stellar/stellar-sdk";
import { cfg } from "./config";

export const server = new rpc.Server(cfg.rpcUrl);
export const bytesVal = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
export const addrVal = (a: string) => new Address(a).toScVal();

/** Build, simulate and assemble a contract call. Throws if simulation fails. */
export async function prepareCall(source: string, contractId: string, method: string, args: xdr.ScVal[]) {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: cfg.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  return server.prepareTransaction(tx);
}

/** Read-only call via simulation. `source` must be an existing account. */
export async function readCall(source: string, contractId: string, method: string, args: xdr.ScVal[]) {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: cfg.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("Simulation failed");
  return scValToNative(sim.result.retval);
}

export async function sendAndWait(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, cfg.passphrase);
  const res = await server.sendTransaction(tx);
  if (res.status === "ERROR") throw new Error("Transaction rejected: " + JSON.stringify(res.errorResult ?? res));
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(res.hash);
    if (r.status === "SUCCESS") return res.hash;
    if (r.status === "FAILED") throw new Error("Transaction failed on-chain");
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  throw new Error("Timed out waiting for confirmation");
}
```

`lib/errors.ts`: friendly messages (never show raw errors to users):

```ts
export function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/Error\(Contract, #4\)/.test(m)) return "This link was already claimed or refunded.";
  if (/Error\(Contract, #5\)/.test(m)) return "This link can’t be refunded yet.";
  if (/trustline/i.test(m)) return "That wallet can’t receive this token yet. Add a trustline for it, or let us create a wallet for you.";
  if (/balance|insufficient/i.test(m)) return "Not enough balance for that amount.";
  if (/user declined|rejected/i.test(m)) return "The request was cancelled.";
  return "Something went wrong. Please try again.";
}
```

**CHECKPOINT:** `npx tsc --noEmit` passes.

## Phase 5: Server: relayer and API routes

**Vercel rules for every route file:** start it with `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` (the claim route also sets `maxDuration`, shown below; set it on `POST /api/links` too). Never read env vars or connect to MongoDB at import time, so `next build` works without secrets.

`lib/server/relayer.ts`:

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { cfg } from "../config";
import { prepareCall, readCall, sendAndWait, addrVal, bytesVal } from "../stellar";
import { fromHex } from "../claim";

const relayer = () => Keypair.fromSecret(process.env.RELAYER_SECRET!);
let queue: Promise<unknown> = Promise.resolve();
// One in-flight relayer tx at a time avoids sequence-number collisions (production: use channel accounts).
const serial = <T,>(fn: () => Promise<T>) => { const run = queue.then(fn); queue = run.catch(() => undefined); return run; };

export async function readLink(linkIdHex: string) {
  const v = await readCall(relayer().publicKey(), cfg.escrowId, "get", [bytesVal(fromHex(linkIdHex))]);
  if (v == null) return null;
  return { sender: v.sender as string, token: v.token as string, amount: String(v.amount), expiresAt: Number(v.expires_at) };
}

export function relayClaim(linkIdHex: string, to: string, sigHex: string) {
  return serial(async () => {
    const kp = relayer();
    for (let attempt = 0; ; attempt++) {
      try {
        const tx = await prepareCall(kp.publicKey(), cfg.escrowId, "claim",
          [bytesVal(fromHex(linkIdHex)), addrVal(to), bytesVal(fromHex(sigHex))]);
        tx.sign(kp);
        return await sendAndWait(tx.toXDR());
      } catch (e) {   // the in-process queue can’t coordinate across serverless instances, so retry on a stale sequence
        if (attempt < 2 && /txBadSeq|bad.?seq/i.test(String((e as Error)?.message))) continue;
        throw e;
      }
    }
  });
}
```

`app/api/claim/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { db, LinkDoc } from "@/lib/server/db";
import { readLink, relayClaim } from "@/lib/server/relayer";
import { friendly } from "@/lib/errors";

const Body = z.object({
  linkId: z.string().regex(/^[0-9a-f]{64}$/),
  to: z.string().refine((a) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a)),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Shared across serverless instances: 10 requests per minute per IP, counted in MongoDB.
async function limited(ip: string) {
  const c = (await db()).collection<{ _id: string; n: number; expireAt: Date }>("rate_limits");
  await c.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  const r = await c.findOneAndUpdate(
    { _id: `${ip}:${Math.floor(Date.now() / 60000)}` },
    { $inc: { n: 1 }, $setOnInsert: { expireAt: new Date(Date.now() + 120000) } },
    { upsert: true, returnDocument: "after" });
  return ((r as any)?.value?.n ?? (r as any)?.n ?? 1) > 10;   // driver versions differ in return shape
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  if (await limited(ip)) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { linkId, to, signature } = parsed.data;
  try {
    if (!(await readLink(linkId))) return NextResponse.json({ error: "This link was already claimed or refunded." }, { status: 404 });
    const hash = await relayClaim(linkId, to, signature);   // simulation fails first if the signature or recipient is bad
    await (await db()).collection<LinkDoc>("links").updateOne(
      { _id: linkId }, { $set: { claimTxHash: hash, claimedBy: to, claimedAt: new Date() } });
    return NextResponse.json({ hash });
  } catch (e) {
    return NextResponse.json({ error: friendly(e) }, { status: 400 });
  }
}
```

`app/api/links/route.ts`: records a link **after** it exists on-chain. All facts come from the chain, never from the client:

```ts
import { NextResponse } from "next/server";
import { db, LinkDoc } from "@/lib/server/db";
import { readLink } from "@/lib/server/relayer";

export async function POST(req: Request) {
  const { linkId, txHash, memo } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f]{64}$/.test(linkId ?? "") || typeof txHash !== "string") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const link = await readLink(linkId);
  if (!link) return NextResponse.json({ error: "Link not found on-chain." }, { status: 404 });
  await (await db()).collection<LinkDoc>("links").updateOne(
    { _id: linkId },
    { $setOnInsert: { ...link, memo: String(memo ?? "").slice(0, 140), createTxHash: txHash, createdAt: new Date() } },
    { upsert: true });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const sender = new URL(req.url).searchParams.get("sender");
  if (!sender) return NextResponse.json({ links: [] });
  const docs = await (await db()).collection<LinkDoc>("links").find({ sender }).sort({ createdAt: -1 }).limit(20).toArray();
  return NextResponse.json({ links: docs.map((d) => ({ id: d._id, token: d.token, amount: d.amount, expiresAt: d.expiresAt, memo: d.memo })) });
}
```

`app/api/links/[id]/route.ts`: status for the claim page and dashboard. `status` is derived: on-chain → `active`; gone with a `claimTxHash` → `claimed`; gone without → `refunded`; unknown → 404. Next 15+ passes `params` as a Promise:

```ts
import { NextResponse } from "next/server";
import { db, LinkDoc } from "@/lib/server/db";
import { readLink } from "@/lib/server/relayer";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{64}$/.test(id)) return NextResponse.json({ error: "Invalid link." }, { status: 400 });
  const chain = await readLink(id);
  const doc = await (await db()).collection<LinkDoc>("links").findOne({ _id: id });
  if (chain) return NextResponse.json({ status: "active", ...chain, expired: chain.expiresAt * 1000 <= Date.now() });
  if (!doc) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  return NextResponse.json({ status: doc.claimTxHash ? "claimed" : "refunded", token: doc.token, amount: doc.amount, expiresAt: doc.expiresAt });
}
```

Add to `next.config.ts` a header so link fragments and referrers never leak, and no API caching:

```ts
async headers() {
  return [
    { source: "/c/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ];
}
```

**CHECKPOINT:** `npm run build` passes. `curl localhost:3000/api/links/<64 zeros>` returns 404 JSON.

## Phase 6: Wallet layer

`lib/wallet.ts`: one interface, two implementations. Freighter is the real wallet; the **demo wallet** (a funded testnet keypair kept in `sessionStorage`) makes demos and testing work without an extension.

```ts
import { Keypair, TransactionBuilder, Operation, Asset } from "@stellar/stellar-sdk";
import { cfg } from "./config";
import { server, sendAndWait } from "./stellar";

export interface Wallet { kind: "freighter" | "demo"; address: string; sign(xdr: string): Promise<string>; }

export async function connectFreighter(): Promise<Wallet> {
  const f = await import("@stellar/freighter-api");     // dynamic: touches `window`
  const c = await f.isConnected();
  if (c.error || !c.isConnected) throw new Error("Freighter isn’t installed. Install it, or use a demo account.");
  const a = await f.requestAccess();
  if (a.error) throw new Error(String(a.error.message ?? a.error));
  return {
    kind: "freighter", address: a.address,
    async sign(xdr) {
      const r = await f.signTransaction(xdr, { networkPassphrase: cfg.passphrase, address: a.address });
      if (r.error) throw new Error(String(r.error.message ?? r.error));
      return r.signedTxXdr;
    },
  };
}

const fromKeypair = (kp: Keypair): Wallet => ({
  kind: "demo", address: kp.publicKey(),
  async sign(xdr) { const tx = TransactionBuilder.fromXDR(xdr, cfg.passphrase); tx.sign(kp); return tx.toXDR(); },
});

export async function friendbot(pub: string) {
  const r = await fetch("https://friendbot.stellar.org?addr=" + encodeURIComponent(pub));
  if (!r.ok) throw new Error("The test-network faucet is busy. Try again in a moment.");
}
export async function createDemoWallet(): Promise<Wallet> {
  const kp = Keypair.random(); await friendbot(kp.publicKey());
  sessionStorage.setItem("jovo.demo", kp.secret()); return fromKeypair(kp);
}
export function restoreDemoWallet(): Wallet | null {
  const s = sessionStorage.getItem("jovo.demo"); return s ? fromKeypair(Keypair.fromSecret(s)) : null;
}

/** New wallets for classic assets (e.g. USDC) must trust the issuer before they can receive it. */
export async function newReceiverWallet(classic?: { code: string; issuer: string }) {
  const kp = Keypair.random(); await friendbot(kp.publicKey());
  if (classic) {
    const tx = new TransactionBuilder(await server.getAccount(kp.publicKey()), { fee: "10000", networkPassphrase: cfg.passphrase })
      .addOperation(Operation.changeTrust({ asset: new Asset(classic.code, classic.issuer) })).setTimeout(60).build();
    tx.sign(kp); await sendAndWait(tx.toXDR());
  }
  return kp; // caller must show kp.secret() once so the user can save it
}
```

Also add `readBalance(wallet, token)` using `readCall(wallet.address, token.contractId, "balance", [addrVal(wallet.address)])` for the amount screen.

**CHECKPOINT:** a throwaway script or page can create a demo wallet and print its address.

## Phase 7: UI: focused, one task per screen

**Keep the existing theme.** Use `next/font/google` `Bricolage_Grotesque` and these tokens in `app/globals.css` (light and dark):

```css
:root{--bg:#EEF3F1;--card:#fff;--ink:#0F2A2E;--muted:#50676B;--line:#C9D6D3;--accent:#1F4BFF;--accent-ink:#fff;--ok:#0B7A4B;--err:#B3261E;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0E1719;--card:#152225;--ink:#E6F0EE;--muted:#92A9AB;--line:#2B3F43;--accent:#7C9BFF;--accent-ink:#0E1719;--ok:#5FD6A0;--err:#FF9A92;color-scheme:dark}}
body{background:var(--bg);color:var(--ink);font-family:var(--font),system-ui,sans-serif;margin:0}
main{max-width:30rem;margin:0 auto;padding:max(1.5rem,env(safe-area-inset-top)) 1.25rem 2rem}
h1{font-size:clamp(2rem,8vw,3rem);line-height:1.04;font-weight:800;letter-spacing:-.03em;margin:0 0 1rem}
button{width:100%;margin-top:.6rem;padding:.9rem 1.2rem;border:0;border-radius:.7rem;background:var(--accent);color:var(--accent-ink);font:600 1rem var(--font),sans-serif;cursor:pointer}
button.quiet{background:transparent;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:not-allowed}
input{width:100%;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:.7rem;padding:.8rem}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.muted{color:var(--muted)} .err{color:var(--err)} .ok{color:var(--ok)}
.bigin{font-size:2.4rem;font-weight:800;border:0;border-bottom:2px solid var(--line);border-radius:0;background:transparent}
.envelope{padding:1.75rem 1.5rem;background:var(--card);border:2px dashed var(--ink);border-radius:1rem}
.envelope.opened{border-style:solid;border-color:var(--ok)}
dialog{border:1px solid var(--line);border-radius:1rem;background:var(--card);color:var(--ink);width:calc(100% - 2rem);max-width:26rem;padding:1.5rem}
dialog::backdrop{background:rgba(0,0,0,.5)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
```

Reusable `components/Modal.tsx`:

```tsx
"use client";
import { useEffect, useRef } from "react";
export function Modal({ open, onClose, locked, children }: { open: boolean; onClose: () => void; locked?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current!; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return <dialog ref={ref} onClose={onClose} onCancel={(e) => locked && e.preventDefault()}>{open && children}</dialog>;
}
```

### Screen map (build exactly these; one primary action each)

**Send** (`/send`): a single client component with `step` state: `"wallet" | "amount" | "expiry" | "creating" | "done" | "error"`.

| Step | Heading | Primary action | Notes |
|---|---|---|---|
| wallet | “Start with a wallet.” | Connect Freighter | Secondary: “Use a demo account” (`createDemoWallet`). Restore with `restoreDemoWallet()` on mount. |
| amount | “How much do you want to send?” | Continue | Token toggle (XLM / USDC), big amount input, balance line. If USDC and the balance is 0, link to `https://faucet.circle.com`. Validate `0 < amount <= MAX_LINK_AMOUNT` and `amount <= balance` (keep a few XLM spare for XLM). |
| expiry | “When can you take it back?” | Review | Chips: 1, 7, 30 days. **Max 30 days** because contract storage lifetime is limited. |
| (modal) | “Review” | Create link | Shows amount, token, refund date. Secondary: “Go back”. |
| creating | “Creating your link…” | none | Progress only. |
| done | “Your link is ready.” | Copy link | Secondary: “Send another”. Warn: anyone with the link can claim. Show explorer link. |
| error | “That didn’t work.” | Try again | Use `friendly(e)`. |

**Claim** (`/c/[id]`, client component reading `location.hash`): `"loading" → "envelope" → "where" → "claiming" → "done"`, plus terminal screens `invalid | claimed | refunded`.

| Step | Heading | Primary action | Notes |
|---|---|---|---|
| envelope | “Someone sent you money.” | Claim money | Dashed envelope with amount and token from `GET /api/links/[id]`. |
| where | “Where should it go?” | Create a wallet for me | Secondary: “Use a wallet I already have” (modal: connect Freighter or paste a G… / C… address). |
| (modal) | “Save your key” | I’ve saved it | **Locked** modal (no Escape). Shows the new wallet’s secret once. |
| claiming | “Claiming…” | none | Calls `POST /api/claim`. |
| done | “It’s yours.” | none | Envelope turns solid green, explorer link. |

Terminal states: `claimed` → “This link was already claimed.” `refunded` → “The sender took this money back.” `invalid` (hash missing, or its derived pubkey ≠ `[id]`) → “This link looks broken. Ask the sender for a new one.”

**Dashboard** (`/dashboard`): connect a wallet, then list `GET /api/links?sender=` with live status from `/api/links/[id]`. Show a **Refund** button only when `status === "active" && expired`, and confirm in a modal.

### Send: key handler

```ts
async function createLink() {
  const seed = newSeed(), linkId = linkIdOf(seed);
  const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
  const tx = await prepareCall(wallet.address, cfg.escrowId, "create", [
    addrVal(wallet.address),
    addrVal(token.contractId),
    nativeToScVal(toUnits(amount, token.decimals), { type: "i128" }),
    bytesVal(linkId),
    nativeToScVal(BigInt(expiresAt), { type: "u64" }),
  ]);
  const hash = await sendAndWait(await wallet.sign(tx.toXDR()));
  await fetch("/api/links", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkId: toHex(linkId), txHash: hash }) });
  return `${location.origin}/c/${toHex(linkId)}#${toB64Url(seed)}`;   // never log or store this
}
```

### Claim: key handler

```ts
async function claim(dest: string) {
  const seed = fromB64Url(location.hash.slice(1));
  const sig = signClaim(seed, cfg.escrowId, dest);
  const res = await fetch("/api/claim", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkId: id, to: dest, signature: toHex(sig) }) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body.hash as string;
}
```

For “Create a wallet for me”, call `newReceiverWallet(token.classic)`, show `kp.secret()` in the locked modal, then `claim(kp.publicKey())`.

Refund (dashboard):

```ts
const tx = await prepareCall(wallet.address, cfg.escrowId, "refund", [bytesVal(fromHex(id))]);
await sendAndWait(await wallet.sign(tx.toXDR()));
```

Accessibility: move focus to each screen’s `<h1>` on step change, use `aria-live="polite"` for status text, label every input, and respect reduced motion.

**CHECKPOINT:** every screen renders; the UI never shows more than one primary action; `npm run lint` passes.

## Phase 8: Integration verification (mandatory)

### 8.1 Message encoding must match the contract

`scripts/verify-message.ts`:

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { cfg } from "../lib/config";
import { claimMessage, toHex, linkIdOf, newSeed } from "../lib/claim";
import { readCall, bytesVal, addrVal } from "../lib/stellar";

const relayer = Keypair.fromSecret(process.env.RELAYER_SECRET!).publicKey();
const to = Keypair.random().publicKey();
const linkId = linkIdOf(newSeed());
const onChain = await readCall(relayer, cfg.escrowId, "claim_message", [bytesVal(linkId), addrVal(to)]);
const local = claimMessage(linkId, cfg.escrowId, to);
if (toHex(onChain) !== toHex(local)) { console.error("MISMATCH\n", toHex(onChain), "\n", toHex(local)); process.exit(1); }
console.log("claim message encoding matches");
```

Add to `package.json` (Node 20.6+): `"verify:message": "node --env-file=.env.local --import tsx scripts/verify-message.ts"`. If top-level await is rejected, wrap it in an async `main()`.

### 8.2 End-to-end script

`scripts/e2e.ts`: using only `lib/*` (no browser), do this and print `E2E OK`:
1. Fund a sender keypair with Friendbot; build and sign `create` for 5 XLM with a fresh seed.
2. `readLink` shows it as active.
3. Fund a recipient keypair; `signClaim`, then `relayClaim`.
4. Assert the recipient’s XLM balance increased by 5 and `readLink` is `null`.
5. Create a second link with a 1-second-future expiry (`expires_at` must be later than the ledger time), wait, then `refund` as the sender and assert the balance returns.

Add `"e2e": "node --env-file=.env.local --import tsx scripts/e2e.ts"`.

### 8.3 Manual QA

1. XLM link with a demo wallet → open in a private window → “Create a wallet for me” → claimed.
2. Repeat with USDC (get test USDC from the Circle faucet first).
3. Open a claimed link → “already claimed”.
4. Tamper with the fragment → “looks broken”.
5. Create a 1-day link, advance nothing, confirm Refund is hidden; after expiry, confirm Refund works.
6. Run on a phone-width viewport; verify one primary button per screen.

**CHECKPOINT:** `npm run verify:message`, `npm run e2e`, and the manual QA all pass.

## Phase 9: Docs

Write both files in full (no placeholders).

**`README.md`** must contain: what Jovo is (two sentences), a short architecture diagram (reuse the one above), feature list, tech stack, project structure, quick start (3 commands), environment variable table, how the claim signature works, security model and known limits, “Decisions” section, and license.

**`SETUP.md`** must contain, with copy-paste commands: prerequisites; clone and install; `docker compose up -d`; create `.env.local`; deploy the contract (`scripts/deploy.sh`); get SAC IDs; create and fund the relayer; fill `.env.local`; `npm run verify:message`; `npm run dev`; demo script (send, copy, claim in a private window); troubleshooting for: Freighter on the wrong network, `Buffer is not defined`, missing trustline, expired contract storage (“restore” needed), RPC rate limits, Friendbot failures.

Add npm scripts: `contract:test` (`cargo test --manifest-path contracts/escrow/Cargo.toml`), `contract:deploy` (`bash scripts/deploy.sh`), `verify:message`, `e2e`.

## Phase 10: Deploy to Vercel

1. **Database:** MongoDB Atlas (free cluster, a database user, and a network access rule that allows Vercel). Docker Compose is for local development only.
2. **Environment variables** to set in Vercel (all environments): every name in `.env.example`. Mark `RELAYER_SECRET` and `MONGODB_URI` as sensitive. `NEXT_PUBLIC_*` values are **inlined at build time**, so redeploy after changing them.
3. **Order of operations:** deploy the contract and relayer first (Phase 2), set the variables, then deploy the app.
4. **Duration:** `maxDuration = 60` may exceed the plan limit. If it does, lower it and have the client poll `GET /api/links/[id]` for the final status instead of waiting for confirmation in the request.
5. **Docs:** add a “Deploying to Vercel” section to `README.md` and `SETUP.md` covering the steps above, the Root Directory (Case A), and a post-deploy smoke test: create a link with a demo wallet, claim it in a private window, and confirm the dashboard status.

**CHECKPOINT:** `npm run build` succeeds locally with only the `NEXT_PUBLIC_*` variables set.

## Security checklist and known limits

- The relayer is a **hot wallet**: fund it with a few test XLM only. It serializes transactions, so throughput is low (production: channel accounts and a queue).
- Rate limiting is MongoDB-backed and per IP; tune the limits before any real use.
- A claim link is a **bearer secret**. Anyone who sees the full URL can claim. Share it privately.
- Link status “claimed vs refunded” is inferred from our database. A claim submitted by a third-party relayer would show as “refunded”.
- Expiry max is 30 days because persistent storage has a maximum lifetime. Archived entries can be restored; add a restore flow in v2.
- The contract is **unaudited**. Do not use with real funds.
- v2 ideas: sponsored trustlines and reserves so any wallet can receive USDC, batch links, sender-recoverable links, a Soroban-native test token (no trustlines), and mainnet hardening.

## Final report

When finished, reply with: the project structure (and Case A or B), the results of `cargo test`, `npm run verify:message`, `npm run e2e`, `npm run lint` and `npm run build`, the deployed contract and token IDs, the Vercel variable names (no values), every deviation from this guide with the reason, and anything you couldn’t verify.

## Definition of done

- [ ] `cargo test` passes and the contract is deployed on testnet
- [ ] `npm run verify:message` and `npm run e2e` pass
- [ ] Send, claim, refund and dashboard flows work in the browser with Freighter and the demo wallet
- [ ] XLM and USDC links both work end to end
- [ ] One primary action per screen; keyboard and screen-reader basics in place
- [ ] No secrets in git, logs, client bundles or MongoDB
- [ ] `README.md` and `SETUP.md` complete and verified by following them from a clean clone