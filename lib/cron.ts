import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Auth for scheduled jobs (Render Cron Jobs call these endpoints over HTTPS):
 * `Authorization: Bearer <KAIROS_CRON_SECRET>`. Not a session and not a browser, so no
 * CSRF/origin check applies. The secret must be at least 32 characters, or every cron
 * endpoint refuses to run. Returns null when authorized, otherwise the response to send.
 */
export function authorizeCron(req: Request): Response | null {
  const secret = process.env.KAIROS_CRON_SECRET ?? "";
  if (secret.length < 32) {
    return Response.json({ error: "CRON_NOT_CONFIGURED", message: "Set KAIROS_CRON_SECRET (32+ characters)" }, { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const sha = (s: string) => createHash("sha256").update(s).digest();
  if (!given || !timingSafeEqual(sha(given), sha(secret))) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}

export const CRON_PATHS = ["/api/cron/agent-run", "/api/cron/demo-reset"] as const;
