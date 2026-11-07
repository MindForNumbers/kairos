import { NextResponse } from "next/server";
import { deleteDraftInvoice, getInvoice } from "@/lib/paypal/invoices";
import { errorResponse } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    return NextResponse.json(await getInvoice((await params).id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    await deleteDraftInvoice((await params).id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
