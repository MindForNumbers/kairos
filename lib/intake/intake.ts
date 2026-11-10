import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getStore } from "@/lib/db";
import { createIntakeBudget } from "@/lib/agent/budget";
import { structuredCall, type ImageInput } from "@/lib/llm/client";
import { checkExtraction, sniffImageType } from "./checks";
import { EXTRACT_PHOTO_USER, EXTRACT_SYSTEM, REVIEW_SYSTEM, extractTextUser, reviewUser } from "./prompts";
import { ExtractionSchema, ReviewSchema, type Finding, type IntakeResult } from "./schema";

/**
 * Invoice intake: photo or voice transcript → New Invoice form values. It never writes to
 * PayPal (scripts/check-boundaries.mjs enforces that): the owner reviews the filled form and
 * clicks Create. Photos are untrusted and are not stored: the bytes live only in memory for
 * the two model calls; the audit log keeps a sha256, size and the outcome.
 *
 *   KAIROS_INTAKE_MODEL           extractor (default claude-sonnet-5-5)
 *   KAIROS_INTAKE_REVIEW_MODEL    reviewer  (default claude-haiku-5-5)
 *   KAIROS_INTAKE_COST_CAP        USD per intake (default 0.15; see lib/agent/budget.ts)
 */

/** Anthropic's limit for a base64 image is 5 MB; the browser downsizes well below it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 4000;

export const extractorModel = () => process.env.KAIROS_INTAKE_MODEL?.trim() || "claude-sonnet-5-5";
export const reviewerModel = () => process.env.KAIROS_INTAKE_REVIEW_MODEL?.trim() || "claude-haiku-5-5";

export class IntakeInputError extends Error {
  constructor(message: string) { super(message); this.name = "IntakeInputError"; }
}

export type IntakeInput = { kind: "photo"; bytes: Uint8Array } | { kind: "voice"; transcript: string };

export async function runIntake(input: IntakeInput, actor: string): Promise<IntakeResult> {
  const intakeId = `int_${randomBytes(12).toString("hex")}`;
  let images: ImageInput[] | undefined;
  let transcript: string | null = null;
  let digest: Record<string, unknown>;

  if (input.kind === "photo") {
    if (input.bytes.byteLength === 0) throw new IntakeInputError("The photo is empty.");
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) throw new IntakeInputError("The photo is over 5 MB. Try a smaller one.");
    const mediaType = sniffImageType(input.bytes);
    if (!mediaType) throw new IntakeInputError("That file isn't a JPEG, PNG, WebP or GIF image.");
    images = [{ mediaType, data: Buffer.from(input.bytes).toString("base64") }];
    digest = { kind: "photo", mediaType, bytes: input.bytes.byteLength, sha256: createHash("sha256").update(input.bytes).digest("hex") };
  } else {
    transcript = input.transcript.trim();
    if (!transcript) throw new IntakeInputError("Nothing was heard. Try again.");
    if (transcript.length > MAX_TRANSCRIPT_CHARS) throw new IntakeInputError(`The voice note is over ${MAX_TRANSCRIPT_CHARS} characters.`);
    digest = { kind: "voice", chars: transcript.length, sha256: createHash("sha256").update(transcript).digest("hex") };
  }

  const store = getStore();
  const budget = createIntakeBudget(intakeId);
  const finish = async (result: IntakeResult) => {
    await store.audit({ actor, event: "intake.extracted", entityType: "intake", entityId: intakeId, data: {
      input: digest, ok: result.ok, costUsd: budget.spentUsd(),
      ...(result.ok
        ? { items: result.fill.items.length, errors: result.findings.filter((f) => f.severity === "error").length, warnings: result.findings.filter((f) => f.severity === "warning").length }
        : { reason: result.reason }),
    } });
    return result;
  };

  // 1. Extract (Sonnet 5.5).
  const extractor = extractorModel();
  const ex = await structuredCall({
    purpose: "intake_extract", model: extractor, system: EXTRACT_SYSTEM,
    user: transcript === null ? EXTRACT_PHOTO_USER : extractTextUser(transcript),
    images, schema: ExtractionSchema, effort: "medium", maxTokens: 8000, budget,
  });
  if (!ex.ok) {
    return finish({ ok: false, reason: "model_failed", costUsd: budget.spentUsd(),
      message: ex.reason === "refusal" ? "The model declined to read this input." : "Couldn't read the fields from this input. Try a clearer photo, or fill the form by hand." });
  }
  const x = ex.data;
  if (!x.billable) {
    return finish({ ok: false, reason: "not_billable", costUsd: budget.spentUsd(),
      message: x.unusableReason ? `This doesn't look like something to invoice: ${x.unusableReason}` : "This doesn't look like something to invoice." });
  }

  // 2. Code checks (deterministic; these always run).
  const { fill, findings } = checkExtraction(x);
  for (const u of x.uncertain) findings.push({ field: mapField(u.field), severity: "warning", message: `Hard to read: ${u.why}`, source: "extractor" });

  // 3. Review (Haiku 5.5). A failed review doesn't block the fill, but the owner is told.
  const reviewer = reviewerModel();
  let reviewed: string | null = reviewer;
  try {
    const rv = await structuredCall({
      purpose: "intake_review", model: reviewer, system: REVIEW_SYSTEM,
      user: reviewUser(JSON.stringify(x), transcript), images, schema: ReviewSchema, effort: "low", maxTokens: 4000, budget,
    });
    if (rv.ok) for (const i of rv.data.issues) findings.push({ field: mapField(i.field), severity: i.severity, message: i.problem, source: "review" });
    else { reviewed = null; findings.push({ field: "input", severity: "warning", message: "The second check couldn't run; review every field yourself.", source: "code" }); }
  } catch (err) {
    if ((err as Error).name === "CostCapError") throw err;
    reviewed = null;
    findings.push({ field: "input", severity: "warning", message: "The second check couldn't run; review every field yourself.", source: "code" });
  }

  return finish({ ok: true, fill, findings: sortFindings(findings), costUsd: budget.spentUsd(), models: { extractor, reviewer: reviewed } });
}

/** Extraction paths → form paths (customer.email → recipient.email, unitPrice → unitAmount). */
export function mapField(path: string): string {
  return path.trim()
    .replace(/^customer\.(email|givenName|surname|businessName)$/, "recipient.$1")
    .replace(/\.(unitPrice|lineTotal)$/, ".unitAmount")
    .replace(/^totalShown$/, "total")
    .replace(/^paymentTerms$/, "termType");
}

const sortFindings = (f: Finding[]) => [...f].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
