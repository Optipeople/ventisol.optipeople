import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

// While the Stationer page loads: the header, the pickers and the station
// tiles, in the same places as the page.
export default function Loading() {
  return (
    <PageShell width="wide" aria-busy>
      <PageHeaderSkeleton titleWidth="w-40" withActions />
      <div className="mb-4 h-[30px] w-64 animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="h-[90px] animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="mt-6 mb-4 h-[24px] w-72 max-w-full animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="grid animate-pulse grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-[172px] rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm"
          />
        ))}
      </div>
      <p className="sr-only">Henter stationer…</p>
    </PageShell>
  );
}
