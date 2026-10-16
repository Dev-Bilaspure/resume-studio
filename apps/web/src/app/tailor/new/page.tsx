import { Suspense } from "react";
import { NewTailoringLoader } from "@/components/tailor/new-tailoring-loader";

type Search = Promise<{ resume?: string }>;

export default function NewTailoringPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={null}>
      <Form searchParams={searchParams} />
    </Suspense>
  );
}

async function Form({ searchParams }: { searchParams: Search }) {
  const { resume } = await searchParams;
  return <NewTailoringLoader resumeId={resume ?? null} />;
}
