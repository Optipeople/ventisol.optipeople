import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

// While the Ugeplan page loads: the header and the drop zone.
export default function Loading() {
  return (
    <PageShell aria-busy>
      <PageHeaderSkeleton titleWidth="w-32" />
      <div className="h-[118px] animate-pulse rounded-[var(--ds-radius-surface)] bg-[var(--ds-grey-light-02)]" />
      <p className="sr-only">Henter ugeplan…</p>
    </PageShell>
  );
}
