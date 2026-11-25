"use client";

import { StrKey } from "@stellar/stellar-sdk";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Modal } from "./Modal";
import { fromUnits } from "@/lib/amounts";
import { friendly } from "@/lib/errors";
import { cfg } from "@/lib/config";
import {
  fromB64Url,
  linkIdOf,
  signClaim,
  toHex,
} from "@/lib/claim";
import { newReceiverWallet, connectFreighter } from "@/lib/wallet";
import { tokenById } from "@/lib/tokens";

type Step =
  | "loading"
  | "envelope"
  | "where"
  | "claiming"
  | "done"
  | "invalid"
  | "claimed"
  | "refunded"
  | "error";

const Status = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("active"),
    token: z.string(),
    amount: z.string(),
    expiresAt: z.number(),
    expired: z.boolean(),
  }),
  z.object({
    status: z.literal("claimed"),
    token: z.string(),
    amount: z.string(),
    expiresAt: z.number(),
  }),
  z.object({
    status: z.literal("refunded"),
    token: z.string(),
    amount: z.string(),
    expiresAt: z.number(),
  }),
]);

export function ClaimFlow({ id }: { id: string }) {
  const [step, setStep] = useState<Step>("loading");
  const [details, setDetails] = useState<z.infer<typeof Status> | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [destination, setDestination] = useState("");
  const [addressInput, setAddressInput] = useState("");
  const [addressError, setAddressError] = useState("");
  const [walletError, setWalletError] = useState("");
  const [destinationModal, setDestinationModal] = useState(false);
  const [saveKeyOpen, setSaveKeyOpen] = useState(false);
  const [newWalletSecret, setNewWalletSecret] = useState("");
  const [claimHash, setClaimHash] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const seed = useRef<Uint8Array | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  useEffect(() => {
    let active = true;

    async function loadLink() {
      if (!/^[0-9a-f]{64}$/.test(id)) {
        setStep("invalid");
        return;
      }

      try {
        const keySeed = fromB64Url(window.location.hash.slice(1));
        if (keySeed.length !== 32 || toHex(linkIdOf(keySeed)) !== id) {
          setStep("invalid");
          return;
        }
        seed.current = keySeed;
      } catch {
        setStep("invalid");
        return;
      }

      try {
        const response = await fetch(`/api/links/${id}`, {
          cache: "no-store",
        });
        if (response.status === 404) {
          setStep("invalid");
          return;
        }
        if (!response.ok) {
          throw new Error("Could not load this payment link.");
        }
        const parsed = Status.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error("Could not read the payment link status.");
        }
        if (!active) return;

        setDetails(parsed.data);
        setStep(
          parsed.data.status === "active" ? "envelope" : parsed.data.status,
        );
      } catch (error) {
        if (active) {
          setErrorMessage(friendly(error));
          setStep("error");
        }
      }
    }

    void loadLink();
    return () => {
      active = false;
    };
  }, [id]);

  async function submitClaim(address: string) {
    const linkSeed = seed.current;
    if (!linkSeed) {
      setStep("invalid");
      return;
    }

    setStep("claiming");
    setErrorMessage("");
    try {
      const signature = signClaim(linkSeed, cfg.escrowId, address);
      const response = await fetch("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          linkId: id,
          to: address,
          signature: toHex(signature),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const apiError =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not claim this link.";
        throw new Error(apiError);
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("hash" in body) ||
        typeof body.hash !== "string"
      ) {
        throw new Error("The claim response was incomplete.");
      }
      setClaimHash(body.hash);
      setStep("done");
    } catch (error) {
      setErrorMessage(friendly(error));
      setStep("where");
    }
  }

  async function createRecipientWallet() {
    const token = details ? tokenById(
      "token" in details ? details.token : "",
    ) : undefined;
    setWalletError("");
    try {
      const keypair = await newReceiverWallet(token?.classic);
      setDestination(keypair.publicKey());
      setNewWalletSecret(keypair.secret());
      setSaveKeyOpen(true);
    } catch (error) {
      setWalletError(friendly(error));
    }
  }

  async function connectRecipientWallet() {
    setWalletError("");
    try {
      const wallet = await connectFreighter();
      setDestinationModal(false);
      await submitClaim(wallet.address);
    } catch (error) {
      setWalletError(friendly(error));
    }
  }

  function useAddress() {
    if (
      !StrKey.isValidEd25519PublicKey(addressInput) &&
      !StrKey.isValidContract(addressInput)
    ) {
      setAddressError("Enter a valid Stellar G… or C… address.");
      return;
    }
    setAddressError("");
    setDestinationModal(false);
    void submitClaim(addressInput);
  }

  function confirmSavedKey() {
    const address = destination;
    setNewWalletSecret("");
    setSaveKeyOpen(false);
    if (address) void submitClaim(address);
  }

  const headingText: Record<Step, string> = {
    loading: "Opening your link…",
    envelope: "Someone sent you money.",
    where: "Where should it go?",
    claiming: "Claiming…",
    done: "It’s yours.",
    invalid: "This link looks broken.",
    claimed: "This link was already claimed.",
    refunded: "The sender took this money back.",
    error: "Couldn’t load this link.",
  };

  const token =
    details && "token" in details ? tokenById(details.token) : undefined;
  const amount =
    details && "amount" in details
      ? fromUnits(details.amount, token?.decimals ?? 7)
      : "";
  const symbol = token?.symbol ?? "tokens";

  return (
    <>
      <section className="stack" aria-live="polite">
        <h1 ref={heading} tabIndex={-1}>
          {headingText[step]}
        </h1>

        {step === "loading" && (
          <p className="muted" role="status">Checking the link…</p>
        )}

        {step === "envelope" && details?.status === "active" && (
          <>
            <div className="envelope">
              <p className="muted">A payment for you</p>
              <p>
                <strong>{amount} {symbol}</strong>
              </p>
              {details.expired && (
                <p className="muted">
                  The refund date has passed, but you can still claim while the
                  link remains active.
                </p>
              )}
            </div>
            <button type="button" onClick={() => setStep("where")}>
              Claim money
            </button>
          </>
        )}

        {step === "where" && (
          <>
            <p className="muted">
              The sender pays the network fee. Choose any wallet address.
            </p>
            {errorMessage && <p className="err" role="alert">{errorMessage}</p>}
            {walletError && <p className="err" role="alert">{walletError}</p>}
            <button type="button" onClick={() => void createRecipientWallet()}>
              Create a wallet for me
            </button>
            <button
              className="quiet"
              type="button"
              onClick={() => setDestinationModal(true)}
            >
              Use a wallet I already have
            </button>
          </>
        )}

        {step === "claiming" && (
          <p className="muted" role="status">
            Sending your signed claim to the Stellar test network…
          </p>
        )}

        {step === "done" && (
          <>
            <div className="envelope opened">
              <p>{amount} {symbol} has been sent to</p>
              <p className="address">{destination}</p>
            </div>
            <a
              href={`${cfg.explorer}/tx/${claimHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          </>
        )}

        {step === "invalid" && (
          <p className="muted" role="alert">
            Ask the sender to create a new link.
          </p>
        )}
        {step === "claimed" && (
          <p className="muted" role="status">
            This payment can only be claimed once.
          </p>
        )}
        {step === "refunded" && (
          <p className="muted" role="status">
            This payment is no longer available.
          </p>
        )}
        {step === "error" && (
          <>
            <p className="err" role="alert">{errorMessage}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Try again
            </button>
          </>
        )}
      </section>

      <Modal open={destinationModal} onClose={() => setDestinationModal(false)}>
        <h2>Choose a wallet</h2>
        {walletError && <p className="err" role="alert">{walletError}</p>}
        <button
          className="quiet"
          type="button"
          onClick={() => void connectRecipientWallet()}
        >
          Connect Freighter
        </button>
        <label htmlFor="destination-address">Or paste a Stellar address</label>
        <input
          id="destination-address"
          autoComplete="off"
          value={addressInput}
          onChange={(event) => setAddressInput(event.target.value.trim())}
          placeholder="G… or C…"
        />
        {addressError && <p className="err" role="alert">{addressError}</p>}
        <button type="button" onClick={useAddress}>
          Use this address
        </button>
        <button
          className="quiet"
          type="button"
          onClick={() => setDestinationModal(false)}
        >
          Cancel
        </button>
      </Modal>

      <Modal
        open={saveKeyOpen}
        locked
        onClose={() => {
          if (!saveKeyOpen) setNewWalletSecret("");
        }}
      >
        <h2>Save your key</h2>
        <p className="err">
          This secret is shown once. Save it somewhere safe; anyone with it can
          control this wallet.
        </p>
        <label htmlFor="new-wallet-secret">Wallet secret key</label>
        <input
          id="new-wallet-secret"
          className="address"
          readOnly
          value={newWalletSecret}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" onClick={confirmSavedKey}>
          I’ve saved it
        </button>
      </Modal>
    </>
  );
}
