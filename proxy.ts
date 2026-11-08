import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_PATHS, SESSION_COOKIE, passwordConfigured, sameOrigin, verifySessionValue } from "@/lib/auth";

/**
 * First gate: every page and every /api route needs a valid session, except PUBLIC_PATHS.
 * Pages and route handlers check again themselves (Next.js advises against relying on
 * Proxy alone for authorization).
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (!passwordConfigured()) {
    const msg = "Kairos is locked: set KAIROS_ADMIN_PASSWORD (12+ characters) and restart.";
    return isApi
      ? NextResponse.json({ error: "AUTH_NOT_CONFIGURED", message: msg }, { status: 503 })
      : new NextResponse(msg, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (!verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value)) {
    if (isApi) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  if (isApi && !sameOrigin(req)) {
    return NextResponse.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next's static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
