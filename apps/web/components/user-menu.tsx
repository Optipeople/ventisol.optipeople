"use client";

import { useEffect, useRef, useState } from "react";
import { logout } from "@/app/login/actions";
import { ChevronDownIcon, LogOutIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Account and session menu in the top-right corner, copied from
 * optipeople.vola without the language switcher (this site is Danish only).
 * The session is read on the server and handed down as props: the cookies
 * are httpOnly.
 */
export type UserMenuUser = {
  email: string;
  name: string | null;
  roleName: string | null;
  accountName: string | null;
};

export function UserMenu({ user }: { user: UserMenuUser }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();

    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
          []
      );
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? items[(idx + 1) % items.length]
          : e.key === "ArrowUp"
            ? items[(idx - 1 + items.length) % items.length]
            : e.key === "Home"
              ? items[0]
              : items[items.length - 1];
      next.focus();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const displayName =
    user.name ??
    (user.email.includes("@") ? user.email.split("@")[0] : user.email);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={user.email}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-[2px] px-1 py-[3px] sm:gap-[10px]",
          "transition-colors hover:bg-white/5",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        )}
      >
        <span className="hidden max-w-[40vw] truncate text-[14px] leading-[14px] text-[#eaeeee] sm:inline">
          Velkommen, {displayName}
        </span>
        <span className="max-w-[40vw] truncate text-[13px] leading-[13px] text-[#eaeeee] sm:hidden">
          {displayName}
        </span>
        <span
          aria-hidden
          className={cn(
            "flex h-[26px] shrink-0 items-center justify-center rounded-[2px] px-[7px] py-[3px]",
            "shadow-[0_0.5px_1.25px_rgba(0,0,0,0.3),0_0_0_rgba(0,0,0,0.05)]"
          )}
        >
          <span
            className={cn(
              "flex h-4 w-[15px] items-center justify-center rounded-[2px]",
              "bg-[linear-gradient(180deg,rgba(255,255,255,0.17)_0%,rgba(255,255,255,0)_100%),linear-gradient(90deg,#eaeeee_0%,#eaeeee_100%)]",
              "shadow-[0_1px_2.5px_rgba(0,122,255,0.24),0_0_0_0.5px_rgba(0,122,255,0.12)]"
            )}
          >
            <ChevronDownIcon size={10} className="text-[#134343]" strokeWidth={3} />
          </span>
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={cn(
            "absolute right-0 top-[calc(100%+8px)] z-30 w-[min(calc(100vw-1.5rem),18rem)] overflow-hidden sm:w-64",
            "rounded-[6px] bg-[var(--color-surface)]",
            "border border-[var(--color-hairline)] shadow-[var(--shadow-lg)]"
          )}
        >
          <div className="px-4 py-3">
            <p className="text-[12px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
              Logget ind som
            </p>
            <p className="mt-1 truncate text-[15px] font-medium text-[var(--color-foreground)]">
              {user.email}
            </p>
            {user.roleName && (
              <>
                <p className="mt-3 text-[12px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Rolle
                </p>
                <p className="mt-1 truncate text-[15px] font-medium text-[var(--color-foreground)]">
                  {user.roleName}
                </p>
              </>
            )}
            {user.accountName && (
              <>
                <p className="mt-3 text-[12px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Konto
                </p>
                <p className="mt-1 truncate text-[15px] font-medium text-[var(--color-foreground)]">
                  {user.accountName}
                </p>
              </>
            )}
          </div>

          <div className="h-px bg-[var(--color-hairline)]" />

          <form action={logout}>
            <button
              type="submit"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(
                "flex w-full items-center gap-2 px-4 py-3 text-left text-[15px]",
                "text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-muted)]"
              )}
            >
              <LogOutIcon size={16} />
              Log ud
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
