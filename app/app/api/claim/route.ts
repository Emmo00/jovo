import { NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { db, LinkDoc } from "@/lib/server/db";
import { readLink, relayClaim } from "@/lib/server/relayer";
import { friendly } from "@/lib/errors";

const Body = z.object({
  linkId: z.string().regex(/^[0-9a-f]{64}$/),
  to: z
    .string()
    .refine(
      (address) =>
        StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address),
    ),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});

export const maxDuration = 60;

async function limited(ip: string): Promise<boolean> {
  const collection = (await db()).collection<{
    _id: string;
    n: number;
    expireAt: Date;
  }>("rate_limits");
  await collection.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  const record = await collection.findOneAndUpdate(
    { _id: `${ip}:${Math.floor(Date.now() / 60_000)}` },
    {
      $inc: { n: 1 },
      $setOnInsert: { expireAt: new Date(Date.now() + 120_000) },
    },
    { upsert: true, returnDocument: "after" },
  );
  return (record?.n ?? 1) > 10;
}

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (await limited(ip)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { linkId, to, signature } = parsed.data;
  try {
    if (!(await readLink(linkId))) {
      return NextResponse.json(
        { error: "This link was already claimed or refunded." },
        { status: 404 },
      );
    }

    const hash = await relayClaim(linkId, to, signature);
    await (await db())
      .collection<LinkDoc>("links")
      .updateOne(
        { _id: linkId },
        { $set: { claimTxHash: hash, claimedBy: to, claimedAt: new Date() } },
      );
    return NextResponse.json({ hash });
  } catch (error) {
    return NextResponse.json({ error: friendly(error) }, { status: 400 });
  }
}
