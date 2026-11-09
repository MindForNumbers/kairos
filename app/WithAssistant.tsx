import KairosPanel from "./KairosPanel";

/** Page content with the Kairos assistant docked beside it (a drawer on phones). */
export default function WithAssistant({ children, invoiceId = null, invoiceNumber = null }: {
  children: React.ReactNode; invoiceId?: string | null; invoiceNumber?: string | null;
}) {
  return (
    <div className="with-assistant">
      <div className="wa-main">{children}</div>
      <KairosPanel invoiceId={invoiceId} invoiceNumber={invoiceNumber} />
    </div>
  );
}
