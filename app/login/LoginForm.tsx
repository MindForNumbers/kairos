"use client";

import { useState } from "react";

export default function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, next }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      window.location.assign(body.next ?? "/");
      return;
    }
    setBusy(false);
    setPassword("");
    setError(
      res.status === 429 ? `Too many attempts. Try again in ${Math.ceil((body.retryAfterSeconds ?? 900) / 60)} min.`
      : res.status === 503 ? body.message
      : "Wrong password.",
    );
  }

  return (
    <form className="card login" onSubmit={submit}>
      <h1>Kairos</h1>
      <div className="field">
        <label htmlFor="pw">Admin password</label>
        <input id="pw" type="password" autoComplete="current-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="button primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
