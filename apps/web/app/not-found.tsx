import Link from "next/link";
import { PageShell } from "@/components/page-shell";

export default function NotFound() {
  return (
    <PageShell className="py-10 sm:py-16">
      <div className="mx-auto max-w-md rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
        <h1 className="text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">Siden findes ikke</h1>
        <p className="mt-2 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
          <Link href="/" className="text-[var(--ds-midnight-green)] underline">Gå til dagsoverblikket</Link>
        </p>
      </div>
    </PageShell>
  );
}
