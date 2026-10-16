"use client";

import dynamic from "next/dynamic";

/** The job form, client-only: it restores the draft you were typing from this tab's storage. */
export const NewTailoringLoader = dynamic(() => import("./new-tailoring").then((m) => m.NewTailoring), { ssr: false });
