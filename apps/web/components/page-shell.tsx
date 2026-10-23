import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page container every view inside the app shell uses. Keeping the width,
 * gutters and vertical rhythm in one place is what makes the section tab bar
 * (SectionNav, same container) line up with the page content below it.
 */
export function PageShell({ children, className, ...rest }: ComponentProps<"main">) {
  return (
    <main
      className={cn("mx-auto w-full max-w-6xl px-3 py-5 sm:px-6 sm:py-8", className)}
      {...rest}
    >
      {children}
    </main>
  );
}

/**
 * The heading block at the top of a page: title, one line of context, and the
 * page-level actions (the report download links) on the right.
 *
 * The title column shrinks rather than wrapping the actions underneath it, so
 * the actions stay pinned to the right on every page regardless of how long
 * the intro runs. Below `sm` the two stack, actions last.
 */
export function PageHeader({
  title,
  intro,
  actions,
}: {
  title: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 max-w-2xl">
        <h1 className="text-[22px] font-bold leading-[28px] text-[var(--ds-grey-dark-09)]">
          {title}
        </h1>
        {intro && (
          <p className="mt-1 text-[14px] leading-[21px] text-[var(--ds-grey-medium-05)]">
            {intro}
          </p>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}

/**
 * The loading placeholder for PageHeader. Same box model as the real header so
 * swapping in the loaded page does not shift anything below it.
 */
export function PageHeaderSkeleton({
  titleWidth = "w-72",
  withActions = false,
}: {
  titleWidth?: string;
  withActions?: boolean;
}) {
  return (
    <div className="mb-6 flex animate-pulse flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 max-w-2xl flex-1">
        <div className={cn("h-[28px] max-w-full rounded-[2px] bg-[var(--ds-grey-light-02)]", titleWidth)} />
        <div className="mt-1 h-[21px] w-96 max-w-full rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      </div>
      {withActions && (
        <div className="h-[30px] w-[290px] max-w-full shrink-0 rounded-[2px] bg-[var(--ds-grey-light-02)]" />
      )}
    </div>
  );
}

/**
 * The loading placeholder for SubNav. Widths are stand-ins for the pill
 * labels; the count matches the views in the section so the bar does not
 * resize when the real nav arrives.
 */
export function SubNavSkeleton({ items = 3 }: { items?: number }) {
  const widths = ["w-36", "w-44", "w-40", "w-32"];
  return (
    <div className="mb-6 flex animate-pulse gap-[6px] border-b border-[var(--ds-grey-light-02)] pb-3">
      {Array.from({ length: items }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "h-[30px] rounded-[2px] bg-[var(--ds-grey-light-02)]",
            widths[i % widths.length]
          )}
        />
      ))}
    </div>
  );
}
