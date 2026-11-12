import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <PageShell className="py-10 sm:py-16">
      <div className="mx-auto max-w-md rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-8 text-center shadow-sm">
        <p className="text-[14px] font-bold uppercase tracking-wide text-[var(--color-muted-foreground)]">404</p>
        <h1 className="mt-2 text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">Siden findes ikke</h1>
        <Link href="/" className={buttonClasses({ className: "mt-5" })}>
          Gå til dagsoverblikket
        </Link>
      </div>
    </PageShell>
  );
}
