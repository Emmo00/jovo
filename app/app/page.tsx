export default function Home() {
  return (
    <section className="stack">
      <p className="muted">Stellar testnet · no recipient wallet needed</p>
      <h1>Money, sent by link.</h1>
      <p>
        Lock XLM or USDC in escrow, share a private link, and let the recipient
        claim it to their wallet.
      </p>
      <a className="button-link" href="/send">
        Send money
      </a>
      <a href="/dashboard">Manage your links</a>
    </section>
  );
}
