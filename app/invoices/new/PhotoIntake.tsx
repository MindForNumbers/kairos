"use client";

import { useEffect, useRef, useState } from "react";

export type FormFill = {
  recipient: { email: string; givenName: string; surname: string; businessName: string };
  items: { name: string; description: string; quantity: string; unitAmount: string; taxPercent: string }[];
  currency: string;
  termType: string;
  note: string;
};
export type Finding = { field: string; severity: "error" | "warning"; message: string; source: "code" | "review" | "extractor" };
export type Filled = { fill: FormFill; findings: Finding[]; costUsd: number; via: "photo" | "voice" };

const MAX_EDGE = 2000;

/**
 * Re-encode in the browser: caps the long edge (fewer image tokens, smaller upload) and drops
 * EXIF metadata such as GPS location, since a canvas export carries none.
 */
async function downsize(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.85));
}

// Chrome's Web Speech API (prefixed). Typed loosely: it isn't in the TS DOM lib.
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};
const speechCtor = (): (new () => Recognition) | null =>
  typeof window === "undefined" ? null : ((window as unknown as { webkitSpeechRecognition?: new () => Recognition; SpeechRecognition?: new () => Recognition }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition ?? null);

export default function PhotoIntake({ onFilled, disabled }: { onFilled: (f: Filled) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState<null | "photo" | "voice">(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [canDictate, setCanDictate] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const recRef = useRef<Recognition | null>(null);
  const finalRef = useRef("");
  useEffect(() => setCanDictate(!!speechCtor()), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function send(body: BodyInit, headers: HeadersInit | undefined, via: "photo" | "voice") {
    setBusy(via);
    setError(null);
    try {
      const res = await fetch("/api/intake", { method: "POST", body, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message ?? "Couldn't read that. Try again, or fill the form by hand.");
      onFilled({ fill: data.fill, findings: data.findings, costUsd: data.costUsd, via });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    let blob: Blob;
    try {
      blob = await downsize(file);
    } catch {
      setError("This browser can't open that image. Try a JPEG or PNG (or take the photo with the camera option).");
      return;
    }
    setPreview(URL.createObjectURL(blob));
    const form = new FormData();
    form.append("photo", blob, "photo.jpg");
    await send(form, undefined, "photo");
    if (fileRef.current) fileRef.current.value = "";
  }

  function startDictation() {
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    finalRef.current = "";
    setHeard("");
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += `${r[0].transcript} `;
        else interim += r[0].transcript;
      }
      setHeard(`${finalRef.current}${interim}`.trim());
    };
    rec.onerror = (e) => { setError(e.error === "not-allowed" ? "Microphone access was blocked." : `Dictation stopped (${e.error}).`); setListening(false); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  function stopDictation() {
    recRef.current?.stop();
    setListening(false);
  }

  const working = busy !== null || disabled;
  return (
    <div className="card intake">
      <h2 style={{ marginTop: 0 }}>Start from a photo</h2>
      <p className="muted">Snap a job note, quote or list. Kairos fills in the form below for you to check; nothing is created until you click a button at the bottom. The photo isn&apos;t saved.</p>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <label className={`button primary${working ? " disabled" : ""}`}>
          {busy === "photo" ? "Reading photo…" : "Take or choose photo"}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden disabled={working}
            onChange={(e) => onPhoto(e.target.files?.[0])} />
        </label>
        {canDictate && (listening
          ? <button type="button" className="button danger" onClick={stopDictation}>Stop dictating</button>
          : <button type="button" className="button" disabled={working} onClick={startDictation}>{busy === "voice" ? "Reading…" : "Dictate instead"}</button>)}
      </div>
      {(listening || heard) && busy !== "voice" && (
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label>{listening ? "Listening… say the customer, their email, and each item with its price." : "What Kairos heard (edit if needed)"}</label>
          <textarea rows={3} value={heard} onChange={(e) => setHeard(e.target.value)} readOnly={listening} />
          {!listening && heard && (
            <div className="actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="button primary" disabled={working}
                onClick={() => send(JSON.stringify({ transcript: heard }), { "Content-Type": "application/json" }, "voice")}>Fill form from this</button>
              <button type="button" className="button" onClick={() => setHeard("")}>Clear</button>
            </div>
          )}
        </div>
      )}
      {preview && <img src={preview} alt="The photo being read" className="intake-preview" />}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
