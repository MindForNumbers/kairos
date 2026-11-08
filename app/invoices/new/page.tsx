import { requirePageSession } from "@/lib/auth-server";
import InvoiceForm from "./InvoiceForm";

export default async function NewInvoicePage() {
  await requirePageSession("/invoices/new");
  return (
    <>
      <h1>New invoice</h1>
      <InvoiceForm />
    </>
  );
}
