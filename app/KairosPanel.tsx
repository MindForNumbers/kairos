"use client";

import { useRouter } from "next/navigation";
import KairosAssistant from "@/components/kairos/KairosAssistant";

/**
 * The Kairos app's own mount of the embeddable assistant (components/kairos/): docked beside
 * the page, Next.js routing for its links, and the app's theme colors (.kairos-app-theme in
 * globals.css). A host dashboard mounts the same component; see the README.
 */
export default function KairosPanel({ invoiceId = null, invoiceNumber = null }: { invoiceId?: string | null; invoiceNumber?: string | null }) {
  const router = useRouter();
  return (
    <KairosAssistant
      layout="docked"
      className="kairos-app-theme"
      context={invoiceId ? { invoiceId, invoiceNumber } : null}
      onNavigate={(path) => router.push(path)}
      onDraftsCreated={() => router.refresh()} // home tiles and the Approvals badge pick up new drafts
    />
  );
}
