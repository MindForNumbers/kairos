import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, passwordConfigured, verifySessionValue } from "./auth";

/** Second gate for pages: redirect to /login unless the session cookie is valid. */
export async function requirePageSession(path: string): Promise<void> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!passwordConfigured() || !verifySessionValue(value)) {
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
}
