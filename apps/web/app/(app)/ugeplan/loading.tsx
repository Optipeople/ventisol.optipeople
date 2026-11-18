import { PageHeaderSkeleton, PageShell } from "@optipeople/ui/blocks";

const block = "rounded-[4px] bg-[var(--ds-grey-light-02)]";
const card = "rounded-[var(--ds-radius-surface)] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm";

// While the Ugeplan page loads: the header, the week, the tiles and the table.
export default function Loading() {
  return (
    <PageShell aria-busy>
      <PageHeaderSkeleton titleWidth="w-32" withActions />
      <div className={`${card} h-[90px] animate-pulse`} />
      <div className="mt-6 grid animate-pulse grid-cols-2 gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={`${card} px-6 py-5`}>
            <div className={`h-[14px] w-20 ${block}`} />
            <div className={`mt-2 h-[28px] w-16 ${block}`} />
            <div className={`mt-1 h-[14px] w-40 ${block}`} />
          </div>
        ))}
      </div>
      <div className={`mt-8 h-[24px] w-40 animate-pulse ${block}`} />
      <div className={`${card} mt-3 animate-pulse p-4`}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={`mt-3 h-[18px] first:mt-0 ${block}`} />
        ))}
      </div>
      <p className="sr-only">Henter ugeplan…</p>
    </PageShell>
  );
}
