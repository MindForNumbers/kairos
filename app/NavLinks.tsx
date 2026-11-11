"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home", match: (p: string) => p === "/" },
  { href: "/invoices", label: "Invoices", match: (p: string) => p.startsWith("/invoices") },
  { href: "/approvals", label: "Approvals", match: (p: string) => p.startsWith("/approvals") },
  { href: "/settings/incentives", label: "Incentives", match: (p: string) => p.startsWith("/settings") },
];

export default function NavLinks({ approvals }: { approvals: number }) {
  const path = usePathname();
  return (
    <>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={`nav-link ${l.match(path) ? "active" : ""}`} aria-current={l.match(path) ? "page" : undefined}>
          {l.label}
          {l.href === "/approvals" && approvals > 0 && <span className="nav-badge" aria-label={`${approvals} waiting`}>{approvals}</span>}
        </Link>
      ))}
    </>
  );
}
