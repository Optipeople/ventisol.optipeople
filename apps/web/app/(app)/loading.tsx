import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

export default function Loading() {
  return (
    <PageShell width="wide" aria-busy>
      <PageHeaderSkeleton titleWidth="w-56" />
      <div className="mb-6 grid animate-pulse grid-cols-2 gap-6 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[117px] rounded-[2px] bg-[var(--ds-grey-light-02)]" />
        ))}
      </div>
      <div className="animate-pulse rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm">
        <div className="h-[42px] border-b border-[var(--ds-grey-light-03)] bg-[#f0f5f5]" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex h-[36px] items-center gap-6 border-b border-[var(--ds-grey-light-02)] px-[10px]">
            <div className="h-[14px] w-24 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-40 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-28 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
            <div className="h-[14px] w-16 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
          </div>
        ))}
      </div>
      <p className="sr-only">Henter data…</p>
    </PageShell>
  );
}
