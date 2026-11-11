"use client";

import KairosAssistant from "@/components/kairos/KairosAssistant";

/**
 * An example host: a plain business dashboard that mounts the Kairos assistant inline.
 * Everything outside the assistant is placeholder host chrome, styled neutrally on purpose.
 */
export default function HostDemo() {
  return (
    <div className="host-demo">
      <div className="host-bar">
        <span className="host-logo" aria-hidden />
        <strong>Your business dashboard</strong>
        <span className="host-muted">example host page</span>
      </div>
      <div className="host-grid">
        <section className="host-widget">
          <h3>Your widgets</h3>
          <p className="host-muted">Orders, inventory, bookings: whatever the dashboard already shows. Kairos doesn&apos;t touch them.</p>
        </section>
        <section className="host-widget">
          <h3>More of your widgets</h3>
          <p className="host-muted">The assistant on the right is the same component the Kairos app uses, mounted with <code>layout=&quot;inline&quot;</code> and the host&apos;s accent color.</p>
        </section>
        <div className="host-assistant">
          <KairosAssistant
            layout="inline"
            title="Kairos"
            storageKey="kairos.embed-demo.session"
            className="host-demo-kairos"
            onNavigate={(path) => window.open(path, "_blank", "noopener")}
          />
        </div>
      </div>
    </div>
  );
}
