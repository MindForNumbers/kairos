import { cleanUntrusted, flagUntrusted } from "@/lib/agent/untrusted";
import type { Extraction, Finding, FormFill, Term } from "./schema";

/**
 * Deterministic checks and normalization of an extraction into New Invoice form values.
 * Pure: no I/O. Every change it makes to a value is reported as a finding, so the owner
 * sees what code did as well as what the models said.
 */

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MONEY = /^\d+(\.\d{1,2})?$/;
const QTY = /^\d+(\.\d{1,5})?$/;
const LARGE_LINE_USD = 10_000;

/** "$1,200.50" → "1200.50"; "150" → "150.00"; null when it isn't a plain positive amount. */
export function normalizeMoney(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s$€£¥,]/g, "").replace(/^(USD|EUR|GBP|CAD|AUD)/i, "").replace(/(USD|EUR|GBP|CAD|AUD)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Round half away from zero at 2 decimals, in cents.
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** "3 hrs" → "3"; "1.5" → "1.5"; null if no single leading number. */
export function normalizeQuantity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, "").trim().match(/^(\d+(?:\.\d{1,5})?)\s*[a-zA-Z.]*$/);
  return m ? String(Number(m[1])) : null;
}

const cents = (v: string) => Math.round(Number(v) * 100);
const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function checkExtraction(x: Extraction): { fill: FormFill; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (field: string, severity: Finding["severity"], message: string) => findings.push({ field, severity, message, source: "code" });

  // ---- Customer ----
  const email = (x.customer.email ?? "").trim().replace(/\s+/g, "").toLowerCase();
  if (!email) add("recipient.email", "error", "No email address found. Enter the customer's email.");
  else if (!EMAIL.test(email)) add("recipient.email", "error", `"${cleanUntrusted(x.customer.email, 80)}" isn't a valid email address.`);
  const givenName = cleanUntrusted(x.customer.givenName, 140) ?? "";
  const surname = cleanUntrusted(x.customer.surname, 140) ?? "";
  const businessName = cleanUntrusted(x.customer.businessName, 300) ?? "";
  if (!givenName && !surname && !businessName) add("recipient.givenName", "warning", "No customer or business name found.");

  // ---- Items ----
  if (x.items.length === 0) add("items", "error", "No line items found. Add at least one.");
  if (x.items.length > 100) add("items", "error", `Found ${x.items.length} line items; an invoice can hold 100.`);
  let computed = 0;
  let allPriced = true;
  const items = x.items.slice(0, 100).map((it, i) => {
    const f = (k: string) => `items[${i}].${k}`;
    const name = cleanUntrusted(it.name, 200) ?? "";
    if (!name) add(f("name"), "error", "Item has no name.");

    let quantity = normalizeQuantity(it.quantity);
    if (quantity === null) { add(f("quantity"), "error", `Quantity "${cleanUntrusted(it.quantity, 40)}" isn't a number; set it.`); quantity = ""; }
    else if (!QTY.test(quantity) || Number(quantity) <= 0) { add(f("quantity"), "error", "Quantity must be more than 0."); }
    else if (quantity !== it.quantity.trim()) add(f("quantity"), "warning", `Quantity read as "${cleanUntrusted(it.quantity, 40)}"; filled in as ${quantity}.`);

    let unit = normalizeMoney(it.unitPrice);
    const line = normalizeMoney(it.lineTotal);
    if (unit === null && line !== null && quantity && Number(quantity) > 0) {
      // Only a line total is shown: derive the unit price, and say so.
      const derived = (cents(line) / Number(quantity)) / 100;
      unit = derived.toFixed(2);
      if (Number(quantity) !== 1) add(f("unitAmount"), "warning", `No unit price shown; ${fmt(cents(unit))} = line total ${fmt(cents(line))} ÷ ${quantity}.`);
      if (cents(unit) * Number(quantity) !== cents(line)) add(f("unitAmount"), "error", `${fmt(cents(line))} doesn't divide evenly by ${quantity}; check the price.`);
    }
    if (unit === null) { add(f("unitAmount"), "error", it.unitPrice ? `Price "${cleanUntrusted(it.unitPrice, 40)}" isn't an amount; set it.` : "No price found; set it."); unit = ""; allPriced = false; }
    else if (!MONEY.test(unit) || cents(unit) <= 0) { add(f("unitAmount"), "error", "Price must be more than $0.00."); allPriced = false; }

    let tax = "";
    if (it.taxPercent) {
      const t = it.taxPercent.replace(/[%\s]/g, "");
      if (/^\d+(\.\d{1,3})?$/.test(t) && Number(t) <= 100) tax = String(Number(t));
      else add(f("taxPercent"), "error", `Tax "${cleanUntrusted(it.taxPercent, 20)}" isn't a percentage; set it or clear it.`);
    }

    if (unit && quantity && QTY.test(quantity)) {
      const lineCents = Math.round(cents(unit) * Number(quantity));
      if (line !== null && it.unitPrice && Math.abs(lineCents - cents(line)) > 1) {
        add(f("unitAmount"), "error", `${quantity} × ${fmt(cents(unit))} = ${fmt(lineCents)}, but the line total reads ${fmt(cents(line))}.`);
      }
      if (lineCents > LARGE_LINE_USD * 100) add(f("unitAmount"), "warning", `Line total ${fmt(lineCents)} is unusually large; double-check it.`);
      computed += Math.round(lineCents * (1 + (Number(tax) || 0) / 100));
    }
    return { name, description: cleanUntrusted(it.description, 1000) ?? "", quantity, unitAmount: unit, taxPercent: tax };
  });

  // ---- Total ----
  const shown = normalizeMoney(x.totalShown);
  if (x.totalShown && shown === null) add("total", "warning", `Couldn't read the total "${cleanUntrusted(x.totalShown, 40)}" to compare it.`);
  if (shown !== null && allPriced && items.length) {
    if (Math.abs(cents(shown) - computed) > 1) add("total", "error", `Line items add up to ${fmt(computed)}, but the total shown is ${fmt(cents(shown))}.`);
  } else if (shown === null && items.length) {
    add("total", "warning", "No total shown to cross-check the line items against.");
  }

  // ---- Currency and terms ----
  let currency = (x.currency ?? "").trim().toUpperCase();
  if (!currency || currency === "$") { currency = "USD"; add("currency", "warning", "No currency named; assumed USD."); }
  else if (!/^[A-Z]{3}$/.test(currency)) { add("currency", "error", `Currency "${cleanUntrusted(x.currency, 10)}" isn't a 3-letter code; assumed USD.`); currency = "USD"; }
  let termType: Term = "NET_30";
  if (x.paymentTerms) termType = x.paymentTerms;
  else add("termType", "warning", "No payment terms shown; defaulted to Net 30.");

  // ---- Untrusted text: anything instruction-like is data, and never prefilled as the note ----
  let note = cleanUntrusted(x.note, 4000) ?? "";
  const flags = flagUntrusted(note, givenName, surname, businessName, ...items.map((i) => i.name), ...items.map((i) => i.description));
  if (x.instructionLikeText.length || flags.length) {
    const quoted = x.instructionLikeText.map((t) => `"${cleanUntrusted(t, 160)}"`).join("; ");
    add("input", "warning", `The input contains text that reads like instructions${quoted ? ` (${quoted})` : ""}. Kairos treated it as data and did nothing it asked.`);
  }
  if (note && flagUntrusted(note).length) {
    add("note", "warning", `The note wasn't filled in because it reads like instructions: "${cleanUntrusted(note, 200)}".`);
    note = "";
  }

  return { fill: { recipient: { email, givenName, surname, businessName }, items, currency, termType, note }, findings };
}

/** Image bytes → media type, by magic number (the client's claimed type is not trusted). */
export function sniffImageType(buf: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null {
  const at = (i: number, ...b: number[]) => b.every((v, j) => buf[i + j] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}
