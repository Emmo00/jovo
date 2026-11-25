import { Suspense } from "react";
import { ClaimFlow } from "@/components/ClaimFlow";

async function ClaimPageContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ClaimFlow id={id} />;
}

export default function ClaimPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<p role="status">Opening your link…</p>}>
      <ClaimPageContent params={params} />
    </Suspense>
  );
}
