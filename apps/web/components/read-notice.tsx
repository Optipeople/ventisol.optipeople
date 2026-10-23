import type { ReadResult } from "@/lib/paging";

/** Says when the read was incomplete or slower than it should be. */
export function ReadNotice({ read }: { read: ReadResult }) {
  if (!read.truncated && !read.unordered) return null;
  return (
    <p className="mt-6 rounded-[2px] border border-[var(--ds-tag-orange-dark)] bg-[var(--ds-tag-orange-light)] px-4 py-3 text-[13px] leading-[19px] text-[var(--ds-grey-dark-09)]">
      {read.truncated
        ? `Der er flere scanninger, end der kunne hentes på én gang (${read.pagesRead} sider). Tallene kan mangle de ældste scanninger i perioden.`
        : "OptiCloud returnerede ikke scanningerne sorteret efter tid, så alle sider blev hentet. Det virker, men er langsommere."}
    </p>
  );
}
