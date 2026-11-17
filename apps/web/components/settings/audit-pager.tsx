"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pagination } from "@optipeople/ui";
import { TableFooter } from "@optipeople/ui/blocks";

type Paging =
  /** The pages alone. */
  | { pageCount: number; pageSize?: undefined; total?: undefined }
  /** The whole line under the table: which rows are shown, and the pages. */
  | { pageSize: number; total: number; pageCount?: undefined };

/**
 * Paging for a list paged on the server from the URL: a click goes to the
 * same page with `param` set, keeping the other search params.
 *
 * With `pageSize` and `total` it is the shared TableFooter, which also says
 * which rows are shown. With `pageCount` it is the page buttons alone.
 */
export function AuditPager({
  page,
  basePath,
  params,
  param = "side",
  ...paging
}: {
  page: number;
  basePath: string;
  /** The other search params to carry along (the filters). */
  params: Record<string, string>;
  param?: string;
} & Paging) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function go(next: number) {
    const qs = new URLSearchParams(params);
    if (next > 1) qs.set(param, String(next));
    startTransition(() => router.push(qs.size ? `${basePath}?${qs}` : basePath));
  }

  return (
    <div className={pending ? "opacity-60" : undefined} aria-busy={pending}>
      {paging.pageCount === undefined ? (
        <TableFooter page={page} pageSize={paging.pageSize} total={paging.total} onPageChange={go} />
      ) : (
        <Pagination page={page} pageCount={paging.pageCount} onChange={go} />
      )}
    </div>
  );
}
