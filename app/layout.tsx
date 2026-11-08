import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionValue } from "@/lib/auth";
import { approvalsBadge } from "@/lib/dashboard";
import LogoutButton from "./LogoutButton";
import NavLinks from "./NavLinks";
import "./globals.css";

export const metadata: Metadata = { title: "Test Store · Kairos", description: "Invoicing and collections for Test Store" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const live = (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").toLowerCase() === "live";
  const signedIn = verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value);
  const badge = signedIn ? await approvalsBadge().catch(() => 0) : 0;
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>TS</span>
            <span className="brand-text">
              <span className="brand-name">Test Store</span>
              <span className="brand-sub">Kairos</span>
            </span>
          </Link>
          <span className="connection">Connected to PayPal ({live ? "live" : "sandbox"})</span>
          {signedIn && (
            <nav className="nav">
              <NavLinks approvals={badge} />
              <LogoutButton />
            </nav>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
