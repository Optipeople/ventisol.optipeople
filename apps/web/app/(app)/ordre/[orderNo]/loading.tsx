import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

export default function OrderLoading() {
  return (
    <PageShell width="wide" aria-busy>
      <PageHeaderSkeleton titleWidth="w-48" />
      <div className="mb-5 grid animate-pulse grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[86px] rounded-[2px] bg-[var(--ds-grey-light-02)]" />
        ))}
      </div>
      <div className="mb-5 h-[120px] animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="h-[300px] animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <p className="sr-only">Henter ordren…</p>
    </PageShell>
  );
}
