import { Suspense } from "react";
import { WorkspaceView } from "@/components/workspace/workspace";

type Params = Promise<{ id: string }>;

export default function ResumePage({ params }: { params: Params }) {
  return (
    <div className="h-dvh overflow-hidden">
      <Suspense fallback={null}>
        <Workspace params={params} />
      </Suspense>
    </div>
  );
}

async function Workspace({ params }: { params: Params }) {
  const { id } = await params;
  // Keyed by id: switching resumes starts from a clean editor state. (Resume ids are [A-Za-z0-9._-].)
  return <WorkspaceView key={id} id={id} />;
}
