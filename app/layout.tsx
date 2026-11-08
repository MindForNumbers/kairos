import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionValue } from "@/lib/auth";
import LogoutButton from "./LogoutButton";
import "./globals.css";

export const metadata: Metadata = { title: "Kairos", description: "Invoicing on PayPal" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const sandbox = (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").toLowerCase() !== "live";
  const signedIn = verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">Kairos</Link>
          {sandbox && <span className="badge">Sandbox</span>}
          {signedIn && (
            <nav className="nav">
              <Link href="/">Invoices</Link>
              <Link href="/agent">Agent</Link>
              <Link href="/invoices/new" className="button primary">New invoice</Link>
              <LogoutButton />
            </nav>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
