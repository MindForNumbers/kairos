import type { Money } from "./paypal/invoices";

export function money(m?: Money) {
  if (!m) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency_code }).format(Number(m.value));
}

export function recipientLabel(r?: { billing_info?: { email_address?: string; name?: { given_name?: string; surname?: string; full_name?: string } } }) {
  const n = r?.billing_info?.name;
  const name = n?.full_name || [n?.given_name, n?.surname].filter(Boolean).join(" ");
  return name || r?.billing_info?.email_address || "—";
}
