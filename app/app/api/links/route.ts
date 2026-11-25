import { NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { db, LinkDoc } from "@/lib/server/db";
import { readLink } from "@/lib/server/relayer";

const Body = z.object({
  linkId: z.string().regex(/^[0-9a-f]{64}$/),
  txHash: z.string().regex(/^[0-9a-f]{64}$/i),
  memo: z.string().optional(),
});

export const maxDuration = 60;

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { linkId, txHash, memo } = parsed.data;
  const link = await readLink(linkId);
  if (!link) {
    return NextResponse.json(
      { error: "Link not found on-chain." },
      { status: 404 },
    );
  }

  await (await db())
    .collection<LinkDoc>("links")
    .updateOne(
      { _id: linkId },
      {
        $setOnInsert: {
          ...link,
          memo: memo?.slice(0, 140) ?? "",
          createTxHash: txHash,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  return NextResponse.json({ ok: true });
}

export async function GET(request: Request) {
  const sender = new URL(request.url).searchParams.get("sender");
  if (!sender) return NextResponse.json({ links: [] });
  if (!StrKey.isValidEd25519PublicKey(sender)) {
    return NextResponse.json({ error: "Invalid sender address." }, { status: 400 });
  }

  const docs = await (await db())
    .collection<LinkDoc>("links")
    .find({ sender })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
  return NextResponse.json({
    links: docs.map((document) => ({
      id: document._id,
      token: document.token,
      amount: document.amount,
      expiresAt: document.expiresAt,
      memo: document.memo,
    })),
  });
}
