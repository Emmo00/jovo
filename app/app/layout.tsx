import type { Metadata } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jovo — send money by link",
  description: "Send testnet Stellar tokens with a claimable payment link.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={bricolage.variable}>
      <body>
        <main>
          <header className="topbar">
            <Link className="brand" href="/">
              jovo
            </Link>
            <nav aria-label="Main navigation">
              <Link href="/send">Send</Link>
              <Link href="/dashboard">Dashboard</Link>
            </nav>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
