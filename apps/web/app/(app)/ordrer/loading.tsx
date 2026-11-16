import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

export default function OrdersLoading() {
  return (
    <PageShell width="wide" aria-busy>
      <PageHeaderSkeleton titleWidth="w-32" />
      <div className="mb-5 h-[92px] animate-pulse rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      <div className="animate-pulse rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm">
        <div className="h-[42px] border-b border-[var(--ds-grey-light-03)] bg-[var(--ds-grey-light-01)]" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex h-[36px] items-center gap-6 border-b border-[var(--ds-grey-light-02)] px-[10px]">
            <div className="h-[14px] w-14 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-44 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-16 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-28 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-24 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
          </div>
        ))}
      </div>
      <p className="sr-only">Henter ordrer…</p>
    </PageShell>
  );
}
