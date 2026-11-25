import { Buffer } from "buffer";
import { Address, Keypair } from "@stellar/stellar-sdk";

const DOMAIN = Buffer.from("jovo-claim-v1");

export const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error("Invalid hexadecimal value");
  }
  return Uint8Array.from(
    hex.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
}

export const toB64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function fromB64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid link key");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    (character) => character.charCodeAt(0),
  );
}

export const newSeed = () => crypto.getRandomValues(new Uint8Array(32));

export const linkKeypair = (seed: Uint8Array) => {
  if (seed.length !== 32) {
    throw new Error("Invalid link key");
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
};

export const linkIdOf = (seed: Uint8Array) =>
  Buffer.from(linkKeypair(seed).rawPublicKey());

export function claimMessage(
  linkId: Uint8Array,
  escrowId: string,
  destination: string,
): Buffer {
  if (linkId.length !== 32) {
    throw new Error("Invalid link identifier");
  }
  return Buffer.concat([
    DOMAIN,
    Buffer.from(linkId),
    new Address(escrowId).toScVal().toXDR(),
    new Address(destination).toScVal().toXDR(),
  ]);
}

export function signClaim(
  seed: Uint8Array,
  escrowId: string,
  destination: string,
): Buffer {
  const keypair = linkKeypair(seed);
  return Buffer.from(
    keypair.sign(claimMessage(keypair.rawPublicKey(), escrowId, destination)),
  );
}
