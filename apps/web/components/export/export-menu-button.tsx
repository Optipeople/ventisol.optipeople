"use client";

// The "Hent" button of a page: one button that opens a short list of the
// files the page can be downloaded as. Each entry is a plain download link,
// the route handlers (app/api/export) do the work.

import { useEffect, useId, useRef, useState } from "react";
import { buttonClasses } from "@optipeople/ui";
import { ChevronDownIcon } from "@optipeople/ui/ui/icons";

export interface ExportMenuItem {
  label: string;
  href: string;
}

const ITEM_CLASSES =
  "block w-full whitespace-nowrap px-4 py-[10px] text-left text-[14px] leading-[20px] " +
  "text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-muted)] " +
  "focus-visible:bg-[var(--color-muted)] focus-visible:outline-none";

export function ExportMenuButton({ label, items }: { label: string; items: ReadonlyArray<ExportMenuItem> }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const links = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    links()[0]?.focus();

    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab") {
        setOpen(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const all = links();
      if (all.length === 0) return;
      e.preventDefault();
      const idx = all.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? all[(idx + 1) % all.length]
          : e.key === "ArrowUp"
            ? all[(idx - 1 + all.length) % all.length]
            : e.key === "Home"
              ? all[0]
              : all[all.length - 1];
      next?.focus();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={buttonClasses({ variant: "secondary", size: "sm", className: "gap-[6px]" })}
      >
        {label}
        <ChevronDownIcon size={12} aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={
            "absolute right-0 top-[calc(100%+6px)] z-30 min-w-[180px] overflow-hidden rounded-[6px] " +
            "border border-[var(--color-hairline)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-lg)]"
          }
        >
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              download
              role="menuitem"
              className={ITEM_CLASSES}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
