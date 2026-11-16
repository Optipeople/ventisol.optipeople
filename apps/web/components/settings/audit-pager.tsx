"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pagination } from "@optipeople/ui";

/**
 * Pagination for a list paged on the server from the URL: a click goes to
 * the same page with `param` set, keeping the other search params.
 */
export function AuditPager({
  page,
  pageCount,
  basePath,
  params,
  param = "side",
}: {
  page: number;
  pageCount: number;
  basePath: string;
  /** The other search params to carry along (the filters). */
  params: Record<string, string>;
  param?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function go(next: number) {
    const qs = new URLSearchParams(params);
    if (next > 1) qs.set(param, String(next));
    startTransition(() => router.push(qs.size ? `${basePath}?${qs}` : basePath));
  }

  return (
    <div className={pending ? "opacity-60" : undefined} aria-busy={pending}>
      <Pagination page={page} pageCount={pageCount} onChange={go} />
    </div>
  );
}
