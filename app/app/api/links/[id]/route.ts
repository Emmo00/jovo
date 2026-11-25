import { NextResponse } from "next/server";
import { db, LinkDoc } from "@/lib/server/db";
import { readLink } from "@/lib/server/relayer";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return NextResponse.json({ error: "Invalid link." }, { status: 400 });
  }

  const chain = await readLink(id);
  if (chain) {
    return NextResponse.json({
      status: "active",
      ...chain,
      expired: chain.expiresAt * 1000 <= Date.now(),
    });
  }

  const document = await (await db())
    .collection<LinkDoc>("links")
    .findOne({ _id: id });
  if (!document) {
    return NextResponse.json({ error: "Link not found." }, { status: 404 });
  }

  return NextResponse.json({
    status: document.claimTxHash ? "claimed" : "refunded",
    token: document.token,
    amount: document.amount,
    expiresAt: document.expiresAt,
  });
}
