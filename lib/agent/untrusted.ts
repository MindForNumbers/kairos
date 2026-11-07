/**
 * Customer- and merchant-entered text (invoice notes, item names, recipient names) is
 * DATA. It is cleaned here before any model sees it, and wrapped by the prompt builders
 * as quoted JSON inside <untrusted_data> blocks, never spliced into instructions.
 */

const MAX_LEN = 500;
// Zero-width, bidi-override and other invisible formatting characters used to hide text.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// C0/C1 control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function cleanUntrusted(input: string | null | undefined, max = MAX_LEN): string | null {
  if (input == null) return null;
  let s = input.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, " ");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

// Heuristic flags only. They inform the critic and humans; they are never the sole defense.
const INSTRUCTION_PATTERNS: [string, RegExp][] = [
  ["instruction_override", /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|earlier)\b.{0,20}\b(instructions?|rules?|prompts?)\b/i],
  ["role_injection", /\b(system prompt|you are now|act as|new instructions?|developer mode)\b|<\/?(system|assistant|instructions?)>/i],
  ["status_change_request", /\bmark\b.{0,40}\b(as\s+)?(paid|settled|closed|cancel+ed|void)\b/i],
  ["concession_request", /\b(discount|waive[sd]?|waiver|forgive|write[- ]?off|extension|extend\b.{0,20}\bdue|refund|credit note|\d{1,3}\s?% off)\b/i],
];

export function flagUntrusted(...texts: (string | null | undefined)[]): string[] {
  const joined = texts.filter(Boolean).join("\n");
  return INSTRUCTION_PATTERNS.filter(([, re]) => re.test(joined)).map(([name]) => name);
}
