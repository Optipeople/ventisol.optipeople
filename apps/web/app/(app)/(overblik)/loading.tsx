import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

const block = "rounded-[4px] bg-[var(--ds-grey-light-02)]";
const card = "rounded-[var(--ds-radius-surface)] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm";

// Same boxes as the Overblik page, so nothing jumps when the numbers arrive.
export default function Loading() {
  return (
    <PageShell width="wide" aria-busy>
      <PageHeaderSkeleton titleWidth="w-40" withActions />
      <div className={`${card} grid animate-pulse grid-cols-2 md:grid-cols-4`}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-6 py-5">
            <div className={`h-[14px] w-24 ${block}`} />
            <div className={`mt-2 h-[26px] w-12 ${block}`} />
            <div className={`mt-1 h-[14px] w-32 ${block}`} />
          </div>
        ))}
      </div>
      <div className={`mt-6 h-[150px] animate-pulse ${card}`} />
      <div className="mt-6 grid animate-pulse grid-cols-2 gap-6 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={`h-[117px] ${card}`} />
        ))}
      </div>
      <div className="mt-6 grid animate-pulse gap-6 xl:grid-cols-2">
        <div className={`h-[364px] ${card}`} />
        <div className={`h-[364px] ${card}`} />
      </div>
      <p className="sr-only">Henter overblikket…</p>
    </PageShell>
  );
}
