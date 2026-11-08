import { NextResponse } from "next/server";
import { SESSION_COOKIE, authorize } from "@/lib/auth";

export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
