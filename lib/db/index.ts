import "server-only";
import { resolve } from "node:path";
import { openSqliteStore } from "./sqlite";
import type { Store } from "./types";

export type * from "./types";
export { hashDraft } from "./draft-hash";

// One store per process. Kept on globalThis so Next.js dev reloads don't leak connections.
const g = globalThis as unknown as { __kairosStore?: Store };

/**
 * The only way the app reaches storage. To move to Postgres, add a postgres.ts that
 * implements `Store` and pick it here (e.g. when DATABASE_URL is set).
 */
export function getStore(): Store {
  g.__kairosStore ??= openSqliteStore(resolve(process.env.KAIROS_DB_PATH ?? "data/kairos.db"));
  return g.__kairosStore;
}

/** For tests: an isolated store (":memory:" or a temp file). */
export { openSqliteStore as openStoreForTesting };
