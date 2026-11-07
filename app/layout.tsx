import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "Kairos", description: "Invoicing on PayPal" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const sandbox = (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").toLowerCase() !== "live";
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">Kairos</Link>
          {sandbox && <span className="badge">Sandbox</span>}
          <Link href="/invoices/new" className="button primary">New invoice</Link>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
