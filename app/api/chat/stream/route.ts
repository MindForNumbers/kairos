import { z } from "zod";
import { authorize } from "@/lib/auth";
import { chatTurn } from "@/lib/chat/engine";

export const maxDuration = 300;

const Body = z.object({
  message: z.string().trim().min(1).max(2000),
  sessionId: z.string().regex(/^chat_[a-f0-9]{32}$/).nullish(),
  invoiceId: z.string().regex(/^INV2-[A-Z0-9-]{4,40}$/).nullish(),
});

/**
 * Streaming chat (server-sent events): text deltas as Kairos writes, tool activity lines,
 * draft outcomes, then "done". Same engine, tools, caps and safety rules as POST /api/chat.
 */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "VALIDATION_ERROR" }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const r = await chatTurn(
          { sessionId: parsed.data.sessionId, text: parsed.data.message, invoiceId: parsed.data.invoiceId },
          {
            onText: (delta) => send("text", { delta }),
            onToolStart: (a) => send("tool_start", a),
            onToolDone: (a) => send("tool_done", a),
            // Outcomes only; free-text details stay server-side.
            onProposals: (ps) => send("proposals", { items: ps.map((p) => ({ invoiceNumber: p.invoiceNumber, outcome: p.outcome })) }),
          },
        );
        send("done", { sessionId: r.sessionId, newSession: r.newSession, stop: r.stop, reply: r.reply, costUsd: r.costUsd });
      } catch (err) {
        console.error("[chat/stream]", err);
        send("error", { message: "Kairos couldn't answer just now. Please try again." });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
