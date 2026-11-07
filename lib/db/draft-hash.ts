import { createHash } from "node:crypto";
import type { DraftContent } from "./types";

/**
 * sha256 over a fixed-order serialization of the draft content. The queue binds approval
 * tokens to this value, and the executor recomputes it from the stored row before sending,
 * so any change to the draft after approval invalidates the token.
 */
export function hashDraft(d: DraftContent): string {
  const canonical = JSON.stringify([d.invoiceId, d.kind, d.tone ?? null, d.subject ?? null, d.note ?? null]);
  return createHash("sha256").update("kairos-draft-v1\0").update(canonical).digest("hex");
}
