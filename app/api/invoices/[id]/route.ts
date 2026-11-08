import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { deleteDraftInvoice, getInvoice } from "@/lib/paypal/invoices";
import { errorResponse } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await getInvoice((await params).id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    await deleteDraftInvoice((await params).id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
