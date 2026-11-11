import { requirePageSession } from "@/lib/auth-server";
import HostDemo from "./HostDemo";

export const dynamic = "force-dynamic";

export default async function EmbedDemoPage() {
  await requirePageSession("/embed-demo");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Embedding Kairos</h1>
          <p className="muted subtitle">
            How the assistant looks inside another business dashboard: a self-contained React component with its own neutral styles,
            talking to the Kairos API with the owner&apos;s Kairos session. Links to Approvals and the Director open Kairos in a new tab.
            See &quot;Integrating Kairos into a business dashboard&quot; in the README.
          </p>
        </div>
      </div>
      <HostDemo />
    </>
  );
}
