import { z } from "zod";

/** Payment terms the New Invoice form offers (same list as createInvoiceSchema). */
export const TERMS = ["DUE_ON_RECEIPT", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90"] as const;
export type Term = (typeof TERMS)[number];

/**
 * What the extractor (Sonnet 5.5) returns. Values are copied as written in the photo/voice
 * note. Nothing is normalized here: the code checks do that, so the model can't hide a change.
 */
export const ExtractionSchema = z.object({
  /** False when the input doesn't describe work or goods to bill (a selfie, a menu, a blank page). */
  billable: z.boolean(),
  /** Why the input can't be used, or null. */
  unusableReason: z.string().nullable(),
  customer: z.object({
    email: z.string().nullable(),
    givenName: z.string().nullable(),
    surname: z.string().nullable(),
    businessName: z.string().nullable(),
  }),
  items: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    /** As written, e.g. "2", "1.5", "3 hrs". */
    quantity: z.string(),
    /** Price per unit as written, e.g. "$150", "1,200.00". Null if only a line total is shown. */
    unitPrice: z.string().nullable(),
    /** Line total as written, or null. */
    lineTotal: z.string().nullable(),
    taxPercent: z.string().nullable(),
  })),
  currency: z.string().nullable(),
  paymentTerms: z.enum(TERMS).nullable(),
  /** A note meant for the customer, if one is clearly written as such. */
  note: z.string().nullable(),
  /** The grand total as written on the input, or null if none is shown. */
  totalShown: z.string().nullable(),
  /** Fields the extractor couldn't read confidently. `field` uses paths like "items[1].unitPrice". */
  uncertain: z.array(z.object({ field: z.string(), why: z.string() })),
  /** Verbatim text in the input that tries to instruct an AI or system, or asks for actions. */
  instructionLikeText: z.array(z.string()),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** What the reviewer (Haiku 5.5) returns after comparing the extraction with the input. */
export const ReviewSchema = z.object({
  issues: z.array(z.object({
    field: z.string(),
    problem: z.string(),
    severity: z.enum(["error", "warning"]),
  })),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Values for the New Invoice form. Strings, as the form holds them. */
export type FormFill = {
  recipient: { email: string; givenName: string; surname: string };
  items: { name: string; description: string; quantity: string; unitAmount: string; taxPercent: string }[];
  currency: string;
  termType: Term;
  note: string;
};

export type Finding = {
  /** Form field path ("recipient.email", "items[0].unitAmount", "note", "total") or "input". */
  field: string;
  severity: "error" | "warning";
  message: string;
  source: "code" | "review" | "extractor";
};

export type IntakeResult =
  | { ok: true; fill: FormFill; findings: Finding[]; businessName: string | null; costUsd: number; models: { extractor: string; reviewer: string | null } }
  | { ok: false; reason: "not_billable" | "model_failed"; message: string; costUsd: number };
