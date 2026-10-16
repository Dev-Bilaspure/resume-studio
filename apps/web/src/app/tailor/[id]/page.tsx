import { Suspense } from "react";
import { SessionView } from "@/components/tailor/session-view";

type Params = Promise<{ id: string }>;

export default function TailoringSessionPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <Session params={params} />
    </Suspense>
  );
}

async function Session({ params }: { params: Params }) {
  const { id } = await params;
  return <SessionView key={id} id={id} />;
}
