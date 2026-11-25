"use client";

import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Modal } from "./Modal";
import { friendly } from "@/lib/errors";
import { fromUnits, toUnits } from "@/lib/amounts";
import { bytesVal, addrVal, prepareCall, sendAndWait } from "@/lib/stellar";
import {
  connectFreighter,
  createDemoWallet,
  demoWalletSnapshot,
  readBalance,
  restoreDemoWallet,
  subscribeDemoWallet,
  type Wallet,
} from "@/lib/wallet";
import { cfg } from "@/lib/config";
import { TOKENS, type Token } from "@/lib/tokens";
import { linkIdOf, newSeed, toB64Url, toHex } from "@/lib/claim";

type Step = "wallet" | "amount" | "expiry" | "creating" | "done" | "error";
const MAX_AMOUNT = BigInt(1000) * BigInt(10) ** BigInt(7);
const XLM_RESERVE = BigInt(10) ** BigInt(7);

export function SendFlow() {
  const [walletOverride, setWallet] = useState<Wallet | null>(null);
  const demoSecret = useSyncExternalStore(
    subscribeDemoWallet,
    demoWalletSnapshot,
    () => null,
  );
  const restoredWallet = useMemo(
    () => (demoSecret ? restoreDemoWallet(demoSecret) : null),
    [demoSecret],
  );
  const wallet = walletOverride ?? restoredWallet;
  const [step, setStep] = useState<Step>("wallet");
  const currentStep = step === "wallet" && wallet ? "amount" : step;
  const [token, setToken] = useState<Token>(TOKENS[0]);
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState(1);
  const [reviewExpiry, setReviewExpiry] = useState<number | null>(null);
  const [balanceResult, setBalanceResult] = useState<{
    key: string;
    value: bigint | null;
    error: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [warning, setWarning] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [transactionHash, setTransactionHash] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const retryAction = useRef<(() => void) | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [currentStep]);

  const balanceKey = `${wallet?.address ?? ""}:${token.contractId}`;
  const balance = balanceResult?.key === balanceKey ? balanceResult.value : null;
  const balanceError =
    balanceResult?.key === balanceKey ? balanceResult.error : "";
  const balanceLoading = Boolean(
    wallet && token.contractId && balanceResult?.key !== balanceKey,
  );

  useEffect(() => {
    let active = true;
    if (!wallet || !token.contractId) {
      return () => {
        active = false;
      };
    }

    readBalance(wallet, token)
      .then((value) => {
        if (active) setBalanceResult({ key: balanceKey, value, error: "" });
      })
      .catch((error: unknown) => {
        if (active) {
          setBalanceResult({
            key: balanceKey,
            value: null,
            error: friendly(error),
          });
        }
      });

    return () => {
      active = false;
    };
  }, [balanceKey, wallet, token]);

  const amountUnits = useMemo(() => {
    try {
      return toUnits(amount, token.decimals);
    } catch {
      return null;
    }
  }, [amount, token]);

  const maxAvailable =
    balance === null
      ? null
      : balance - (token.symbol === "XLM" ? XLM_RESERVE : BigInt(0));
  const amountIsValid =
    amountUnits !== null &&
    amountUnits > BigInt(0) &&
    amountUnits <= MAX_AMOUNT &&
    maxAvailable !== null &&
    amountUnits <= maxAvailable;

  async function connect(kind: "freighter" | "demo") {
    try {
      const connected =
        kind === "freighter"
          ? await connectFreighter()
          : await createDemoWallet();
      setWallet(connected);
      setBalanceResult(null);
      setErrorMessage("");
      setStep("amount");
    } catch (error) {
      setErrorMessage(friendly(error));
      retryAction.current = () => {
        void connect(kind);
      };
      setStep("error");
    }
  }

  async function createLink() {
    if (!wallet || amountUnits === null || !amountIsValid) return;

    setReviewOpen(false);
    setWarning("");
    setStep("creating");
    try {
      if (!cfg.escrowId) {
        throw new Error("The escrow contract is not configured.");
      }

      const seed = newSeed();
      const linkId = linkIdOf(seed);
      const expiresAt = Math.floor(Date.now() / 1000) + days * 86_400;
      const transaction = await prepareCall(
        wallet.address,
        cfg.escrowId,
        "create",
        [
          addrVal(wallet.address),
          addrVal(token.contractId),
          nativeToScVal(amountUnits, { type: "i128" }),
          bytesVal(linkId),
          nativeToScVal(BigInt(expiresAt), { type: "u64" }),
        ],
      );
      const hash = await sendAndWait(await wallet.sign(transaction.toXDR()));
      const generatedLink = `${window.location.origin}/c/${toHex(linkId)}#${toB64Url(seed)}`;
      setLinkUrl(generatedLink);
      setTransactionHash(hash);

      try {
        const response = await fetch("/api/links", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ linkId: toHex(linkId), txHash: hash }),
        });
        if (!response.ok) {
          setWarning(
            "The link is on-chain, but it wasn’t added to your dashboard.",
          );
        }
      } catch {
        setWarning(
          "The link is on-chain, but it wasn’t added to your dashboard.",
        );
      }

      setStep("done");
    } catch (error) {
      setErrorMessage(friendly(error));
      retryAction.current = () => {
        void createLink();
      };
      setStep("error");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopyStatus("Link copied.");
    } catch {
      setCopyStatus("Copy is unavailable. Select and copy the link above.");
    }
  }

  function startAnother() {
    setAmount("");
    setDays(1);
    setToken(TOKENS[0]);
    setWarning("");
    setLinkUrl("");
    setTransactionHash("");
    setStep(wallet ? "amount" : "wallet");
  }

  const headingText: Record<Step, string> = {
    wallet: "Start with a wallet.",
    amount: "How much do you want to send?",
    expiry: "When can you take it back?",
    creating: "Creating your link…",
    done: "Your link is ready.",
    error: "That didn’t work.",
  };

  return (
    <>
      <section className="stack" aria-live="polite">
        <h1 ref={heading} tabIndex={-1}>
          {headingText[currentStep]}
        </h1>

        {currentStep === "wallet" && (
          <>
            <p className="muted">
              Connect Freighter on Stellar Testnet, or make a temporary demo
              wallet.
            </p>
            <button type="button" onClick={() => void connect("freighter")}>
              Connect Freighter
            </button>
            <button
              className="quiet"
              type="button"
              onClick={() => void connect("demo")}
            >
              Use a demo account
            </button>
          </>
        )}

        {currentStep === "amount" && wallet && (
          <>
            <p className="muted address">
              Connected: {wallet.address.slice(0, 7)}…{wallet.address.slice(-5)}
              {wallet.kind === "demo" ? " · demo wallet" : ""}
            </p>
            <div className="row" role="group" aria-label="Choose a token">
              {TOKENS.map((choice) => (
                <button
                  className={`chip quiet${token.symbol === choice.symbol ? " selected" : ""}`}
                  key={choice.symbol}
                  type="button"
                  aria-pressed={token.symbol === choice.symbol}
                  onClick={() => {
                    setBalanceResult(null);
                    setToken(choice);
                  }}
                >
                  {choice.symbol}
                </button>
              ))}
            </div>
            <label htmlFor="send-amount">Amount in {token.symbol}</label>
            <input
              className="bigin"
              id="send-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <p className="muted sr-status" aria-live="polite">
              {balanceLoading
                ? "Loading balance…"
                : balance !== null
                  ? `Available: ${fromUnits(maxAvailable ?? balance, token.decimals)} ${token.symbol}`
                  : ""}
            </p>
            {balanceError && <p className="err" role="alert">{balanceError}</p>}
            {!token.contractId && (
              <p className="err" role="alert">
                {token.symbol} is not configured for this deployment.
              </p>
            )}
            {token.symbol === "USDC" && balance === BigInt(0) && (
              <p className="muted">
                Need test USDC? Visit the{" "}
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                  Circle faucet
                </a>
                .
              </p>
            )}
            {amountUnits !== null &&
              amountUnits > BigInt(0) &&
              amountUnits > MAX_AMOUNT && (
                <p className="err" role="alert">
                  The maximum link amount is 1,000 {token.symbol}.
                </p>
              )}
            {amountUnits !== null &&
              amountUnits > BigInt(0) &&
              maxAvailable !== null &&
              amountUnits > maxAvailable && (
                <p className="err" role="alert">
                  Your balance is too low{token.symbol === "XLM" ? " (leave 1 XLM for fees)" : ""}.
                </p>
              )}
            <button
              type="button"
              disabled={!amountIsValid || balanceLoading || Boolean(balanceError)}
              onClick={() => setStep("expiry")}
            >
              Continue
            </button>
          </>
        )}

        {currentStep === "expiry" && (
          <>
            <p className="muted">
              If it isn’t claimed by then, you can get it back.
            </p>
            <div className="row" role="group" aria-label="Choose expiry">
              {[1, 7, 30].map((choice) => (
                <button
                  className={`chip quiet${days === choice ? " selected" : ""}`}
                  key={choice}
                  type="button"
                  aria-pressed={days === choice}
                  onClick={() => setDays(choice)}
                >
                  {choice} {choice === 1 ? "day" : "days"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setReviewExpiry(Math.floor(Date.now() / 1000) + days * 86_400);
                setReviewOpen(true);
              }}
            >
              Review
            </button>
            <button
              className="quiet"
              type="button"
              onClick={() => setStep("amount")}
            >
              Back
            </button>
          </>
        )}

        {currentStep === "creating" && (
          <p className="muted" role="status">
            Locking your tokens in escrow. Keep this page open.
          </p>
        )}

        {currentStep === "done" && (
          <>
            <div className="card link-card">
              <p className="muted">
                Anyone with this link can claim the money. Share it privately.
              </p>
              <input
                className="link-url"
                aria-label="Your claim link"
                readOnly
                value={linkUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              {warning && <p className="err" role="status">{warning}</p>}
              <p className="muted sr-status" aria-live="polite">{copyStatus}</p>
              <a
                href={`${cfg.explorer}/tx/${transactionHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction
              </a>
            </div>
            <button type="button" onClick={() => void copyLink()}>
              Copy link
            </button>
            <button className="quiet" type="button" onClick={startAnother}>
              Send another
            </button>
          </>
        )}

        {currentStep === "error" && (
          <>
            <p className="err" role="alert">{errorMessage}</p>
            <button
              type="button"
              onClick={() => retryAction.current?.()}
            >
              Try again
            </button>
          </>
        )}
      </section>

      <Modal open={reviewOpen} onClose={() => setReviewOpen(false)}>
        <h2>Review</h2>
        <p>
          Send <strong>{amount} {token.symbol}</strong>
        </p>
        <p>
          Refund available after{" "}
          <strong>
            {reviewExpiry
              ? new Date(reviewExpiry * 1000).toLocaleString()
              : "—"}
          </strong>
        </p>
        <p className="muted">
          Anyone with the link can claim the tokens. Keep it private.
        </p>
        <button type="button" onClick={() => void createLink()}>
          Create link
        </button>
        <button
          className="quiet"
          type="button"
          onClick={() => setReviewOpen(false)}
        >
          Go back
        </button>
      </Modal>
    </>
  );
}
