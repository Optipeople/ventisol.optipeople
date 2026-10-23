import Link from "next/link";
import { OptipeopleLogo } from "@/components/logo";
import { UserMenu, type UserMenuUser } from "@/components/user-menu";

export function AppHeader({ user, fixtures }: { user?: UserMenuUser; fixtures?: boolean }) {
  return (
    <header
      className="relative z-20 shrink-0"
      style={{ backgroundColor: "var(--color-brand)" }}
    >
      <div className="flex h-[42px] w-full items-center justify-between gap-3 px-4 sm:h-[35px] sm:px-6">
        <Link
          href="/"
          aria-label="Optipeople"
          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <OptipeopleLogo className="h-5 w-auto text-white" />
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          {fixtures && (
            <span className="rounded-[2px] bg-[var(--ds-orange)] px-2 py-[2px] text-[12px] font-bold leading-[16px] text-[var(--ds-grey-dark-09)]">
              Eksempeldata
            </span>
          )}
          {user && <UserMenu user={user} />}
          <span className="shrink-0 text-[14px] font-bold leading-none text-white/80">
            Ventisol
          </span>
        </div>
      </div>
    </header>
  );
}
