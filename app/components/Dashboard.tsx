"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";
import { bytesVal, prepareCall, sendAndWait } from "@/lib/stellar";
import { cfg } from "@/lib/config";
import { fromHex } from "@/lib/claim";
import { fromUnits } from "@/lib/amounts";
import { friendly } from "@/lib/errors";
import {
  connectFreighter,
  createDemoWallet,
  demoWalletSnapshot,
  restoreDemoWallet,
  subscribeDemoWallet,
  type Wallet,
} from "@/lib/wallet";
import { tokenById } from "@/lib/tokens";
import { Modal } from "./Modal";

type LinkStatus = "active" | "claimed" | "refunded";
type DashboardLink = {
  id: string;
  token: string;
  amount: string;
  expiresAt: number;
  memo?: string;
  status: LinkStatus;
  expired: boolean;
};

const LinkList = z.array(
  z.object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    token: z.string(),
    amount: z.string(),
    expiresAt: z.number(),
    memo: z.string().optional(),
  }),
);
const Status = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active"), expired: z.boolean() }),
  z.object({ status: z.literal("claimed") }),
  z.object({ status: z.literal("refunded") }),
]);

async function getDashboardLinks(address: string): Promise<{
  links: DashboardLink[];
  error: string;
}> {
  try {
    const response = await fetch(
      `/api/links?sender=${encodeURIComponent(address)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Could not load your links.");
    const result: unknown = await response.json();
    const parsed = z.object({ links: LinkList }).safeParse(result);
    if (!parsed.success) throw new Error("Could not read your link history.");

    const links = await Promise.all(
      parsed.data.links.map(async (link) => {
        const statusResponse = await fetch(`/api/links/${link.id}`, {
          cache: "no-store",
        });
        if (!statusResponse.ok) {
          throw new Error("Could not refresh a link’s status.");
        }
        const status = Status.safeParse(await statusResponse.json());
        if (!status.success) {
          throw new Error("Could not read a link’s status.");
        }
        return {
          ...link,
          status: status.data.status,
          expired:
            status.data.status === "active" ? status.data.expired : false,
        };
      }),
    );
    return { links, error: "" };
  } catch (error) {
    return { links: [], error: friendly(error) };
  }
}

export function Dashboard() {
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
  const [linksState, setLinksState] = useState<{
    address: string;
    links: DashboardLink[];
    error: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [walletMessage, setWalletMessage] = useState("");
  const [refundTarget, setRefundTarget] = useState<string | null>(null);
  const [refunding, setRefunding] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    let active = true;
    const address = wallet.address;
    void getDashboardLinks(address).then((result) => {
      if (active) setLinksState({ address, ...result });
    });
    return () => {
      active = false;
    };
  }, [wallet]);

  async function connect(kind: "freighter" | "demo") {
    setWalletMessage("");
    try {
      const connected =
        kind === "freighter"
          ? await connectFreighter()
          : await createDemoWallet();
      setWallet(connected);
      setLinksState(null);
    } catch (error) {
      setWalletMessage(friendly(error));
    }
  }

  async function refreshLinks() {
    if (!wallet) return;
    setRefreshing(true);
    const result = await getDashboardLinks(wallet.address);
    setLinksState({ address: wallet.address, ...result });
    setRefreshing(false);
  }

  async function refund() {
    if (!wallet || !refundTarget) return;
    setRefunding(true);
    setActionError("");
    try {
      if (!cfg.escrowId) {
        throw new Error("The escrow contract is not configured.");
      }
      const transaction = await prepareCall(
        wallet.address,
        cfg.escrowId,
        "refund",
        [bytesVal(fromHex(refundTarget))],
      );
      await sendAndWait(await wallet.sign(transaction.toXDR()));
      setRefundTarget(null);
      await refreshLinks();
    } catch (error) {
      setActionError(friendly(error));
    } finally {
      setRefunding(false);
    }
  }

  const links =
    wallet && linksState?.address === wallet.address ? linksState.links : [];
  const loading = Boolean(wallet && linksState?.address !== wallet.address);
  const errorMessage =
    (wallet && linksState?.address === wallet.address
      ? linksState.error
      : "") ||
    actionError;

  return (
    <>
      <section className="stack">
        <h1 ref={heading} tabIndex={-1}>
          Your links.
        </h1>
        {!wallet && (
          <>
            <p className="muted">Connect the wallet you used to send.</p>
            {walletMessage && (
              <p className="err" role="alert">
                {walletMessage}
              </p>
            )}
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

        {wallet && (
          <>
            <p className="muted address">
              {wallet.address.slice(0, 7)}…{wallet.address.slice(-5)}
            </p>
            <div className="row">
              <button
                type="button"
                onClick={() => void refreshLinks()}
                disabled={refreshing || loading}
              >
                {refreshing || loading ? "Refreshing…" : "Refresh"}
              </button>
              <a className="button-link" href="/send">
                Send money
              </a>
            </div>
            {errorMessage && (
              <p className="err" role="alert">
                {errorMessage}
              </p>
            )}
            {loading && (
              <p className="muted" role="status">
                Loading your links…
              </p>
            )}
            {!loading && links.length === 0 && (
              <p className="muted">No payment links found for this wallet.</p>
            )}
            {links.map((link) => {
              const token = tokenById(link.token);
              return (
                <article className="card link-card stack" key={link.id}>
                  <h2>
                    {fromUnits(link.amount, token?.decimals ?? 7)}{" "}
                    {token?.symbol ?? "tokens"}
                  </h2>
                  {link.memo && <p>{link.memo}</p>}
                  <p className="muted">
                    Refund date:{" "}
                    {new Date(link.expiresAt * 1000).toLocaleString()}
                  </p>
                  <p className="muted" role="status">
                    Status: {link.status}
                  </p>
                  {link.status === "active" && link.expired && (
                    <button
                      className="quiet"
                      type="button"
                      onClick={() => setRefundTarget(link.id)}
                    >
                      Refund
                    </button>
                  )}
                </article>
              );
            })}
          </>
        )}
      </section>

      <Modal
        open={refundTarget !== null}
        onClose={() => {
          if (!refunding) setRefundTarget(null);
        }}
        locked={refunding}
      >
        <h2>Refund this link?</h2>
        <p>
          The unclaimed tokens will be returned to your wallet. This cannot be
          undone.
        </p>
        {actionError && (
          <p className="err" role="alert">
            {actionError}
          </p>
        )}
        <button type="button" disabled={refunding} onClick={() => void refund()}>
          {refunding ? "Refunding…" : "Confirm refund"}
        </button>
        <button
          className="quiet"
          type="button"
          disabled={refunding}
          onClick={() => setRefundTarget(null)}
        >
          Cancel
        </button>
      </Modal>
    </>
  );
}
