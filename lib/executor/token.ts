import { createHash } from "node:crypto";

/** sha256 of the bearer token. Only this is stored; the executor hashes what it receives the same way. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
