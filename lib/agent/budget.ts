import "server-only";
import { startOfLocalDay } from "@/lib/clock";
import { getStore } from "@/lib/db";
import type { CallMeta, SpendGuard } from "@/lib/llm/client";

/**
 * Spend caps for model calls. Each call is checked against its WORST-CASE cost (full
 * max_tokens, generous prompt estimate) before it is made, so a cap is never exceeded.
 *   KAIROS_RUN_COST_CAP    USD per agent run (default 0.50)
 *   KAIROS_DAILY_COST_CAP  USD per business-timezone day, across all runs (default 5.00)
 */

export class CostCapError extends Error {
  constructor(public cap: "run" | "daily" | "chat_turn", public spentUsd: number, public capUsd: number, public nextMaxUsd: number, public purpose: string) {
    super(`${cap === "run" ? "Run" : cap === "chat_turn" ? "Chat message" : "Daily"} cost cap $${capUsd.toFixed(2)} would be exceeded: spent $${spentUsd.toFixed(4)}, next ${purpose} call could cost up to $${nextMaxUsd.toFixed(4)}`);
    this.name = "CostCapError";
  }
}

function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number of USD, got "${raw}"`);
  return v;
}

export function costCaps() {
  return {
    runUsd: capFromEnv("KAIROS_RUN_COST_CAP", 0.5),
    dailyUsd: capFromEnv("KAIROS_DAILY_COST_CAP", 5),
    chatTurnUsd: capFromEnv("KAIROS_CHAT_TURN_COST_CAP", 0.05),
  };
}

export type Budget = SpendGuard & { spentUsd(): number };

/** One budget per run (runId null = an ad-hoc call outside a run; only the daily cap applies). */
export function createBudget(runId: string | null): Budget {
  const store = getStore();
  const caps = costCaps();
  let spent = 0;

  return {
    spentUsd: () => spent,

    async beforeCall(model, maxCostUsd, purpose) {
      const daily = await store.modelSpendSince(startOfLocalDay());
      let err: CostCapError | null = null;
      if (runId && spent + maxCostUsd > caps.runUsd) err = new CostCapError("run", spent, caps.runUsd, maxCostUsd, purpose);
      else if (daily + maxCostUsd > caps.dailyUsd) err = new CostCapError("daily", daily, caps.dailyUsd, maxCostUsd, purpose);
      if (err) {
        await store.audit({ actor: "system", event: "budget.halt", entityType: runId ? "run" : null, entityId: runId,
          data: { cap: err.cap, capUsd: err.capUsd, spentUsd: err.spentUsd, nextMaxUsd: maxCostUsd, model, purpose } });
        throw err;
      }
    },

    async afterCall(meta: CallMeta) {
      spent += meta.costUsd;
      await store.recordModelCall({
        runId, purpose: meta.purpose, model: meta.model, requestId: meta.requestId,
        inputTokens: meta.inputTokens, outputTokens: meta.outputTokens,
        cacheReadTokens: meta.cacheReadTokens, cacheWriteTokens: meta.cacheWriteTokens, costUsd: meta.costUsd,
      });
    },
  };
}

/**
 * One budget per chat message (the whole tool loop): KAIROS_CHAT_TURN_COST_CAP per message,
 * plus the shared daily cap. Calls are recorded in model_calls with purpose "chat".
 */
export function createChatTurnBudget(sessionId: string): Budget {
  const store = getStore();
  const caps = costCaps();
  let spent = 0;
  return {
    spentUsd: () => spent,
    async beforeCall(model, maxCostUsd, purpose) {
      const daily = await store.modelSpendSince(startOfLocalDay());
      let err: CostCapError | null = null;
      if (spent + maxCostUsd > caps.chatTurnUsd) err = new CostCapError("chat_turn", spent, caps.chatTurnUsd, maxCostUsd, purpose);
      else if (daily + maxCostUsd > caps.dailyUsd) err = new CostCapError("daily", daily, caps.dailyUsd, maxCostUsd, purpose);
      if (err) {
        await store.audit({ actor: "system", event: "budget.halt", entityType: "chat_session", entityId: sessionId,
          data: { cap: err.cap, capUsd: err.capUsd, spentUsd: err.spentUsd, nextMaxUsd: maxCostUsd, model, purpose } });
        throw err;
      }
    },
    async afterCall(meta: CallMeta) {
      spent += meta.costUsd;
      await store.recordModelCall({
        runId: null, purpose: meta.purpose, model: meta.model, requestId: meta.requestId,
        inputTokens: meta.inputTokens, outputTokens: meta.outputTokens,
        cacheReadTokens: meta.cacheReadTokens, cacheWriteTokens: meta.cacheWriteTokens, costUsd: meta.costUsd,
      });
    },
  };
}
