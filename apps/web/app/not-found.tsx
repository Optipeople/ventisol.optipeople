import Link from "next/link";
import { PageShell, SectionCard } from "@optipeople/ui/blocks";
import { buttonClasses } from "@optipeople/ui";

export default function NotFound() {
  return (
    <PageShell width="wide" className="py-10 sm:py-16">
      <SectionCard className="mx-auto max-w-md text-center" bodyClassName="p-8">
        <p className="text-[14px] font-bold uppercase tracking-wide text-[var(--color-muted-foreground)]">404</p>
        <h1 className="mt-2 text-[18px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">Siden findes ikke</h1>
        <Link href="/" className={buttonClasses({ className: "mt-5" })}>
          Gå til dagsoverblikket
        </Link>
      </SectionCard>
    </PageShell>
  );
}
