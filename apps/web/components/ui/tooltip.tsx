import * as React from "react";
import { cn } from "@/lib/utils";

type TooltipSide = "top" | "bottom" | "left" | "right";
type TooltipAlign = "start" | "center" | "end";
type TooltipVariant = "light" | "dark";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: TooltipSide;
  /** Where a top/bottom tooltip sits along the child. "end" grows leftwards. */
  align?: TooltipAlign;
  variant?: TooltipVariant;
  /** Limit the width and allow wrapping, for a sentence rather than a word. */
  multiline?: boolean;
  /** Classes for the wrapping span. */
  className?: string;
  /** Suppress the tooltip without removing surrounding markup. */
  disabled?: boolean;
}

const alignClasses: Record<TooltipAlign, string> = {
  start: "left-0",
  center: "left-1/2 -translate-x-1/2",
  end: "right-0",
};

function sideClasses(side: TooltipSide, align: TooltipAlign): string {
  switch (side) {
    case "top":
      return cn("bottom-full mb-[6px]", alignClasses[align]);
    case "bottom":
      return cn("top-full mt-[6px]", alignClasses[align]);
    case "left":
      return "right-full top-1/2 -translate-y-1/2 mr-[6px]";
    case "right":
      return "left-full top-1/2 -translate-y-1/2 ml-[6px]";
  }
}

/**
 * Tooltip, from optipeople.ai.chat. Appears on hover and on keyboard focus of
 * the wrapped child, so the child must be focusable for keyboard and touch
 * users to reach it. Pure CSS: it renders inside server components.
 *
 * It is positioned absolutely, so a scrolling or clipping ancestor cuts it
 * off. Keep a plain title attribute in those places.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  variant = "dark",
  multiline = false,
  className,
  disabled = false,
}: TooltipProps) {
  if (disabled || content == null || content === "") {
    return children;
  }

  const isDark = variant === "dark";

  return (
    <span className={cn("group relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute z-50 select-none",
          "rounded-[2px] px-[12px] py-[6px]",
          // Reset what a label around it may set (the KPI labels are bold uppercase).
          "text-left text-[14px] font-normal tracking-normal normal-case",
          "shadow-[var(--ds-shadow-button)]",
          "opacity-0 transition-opacity duration-150",
          "group-hover:visible group-hover:opacity-100",
          "group-focus-within:visible group-focus-within:opacity-100",
          isDark
            ? "bg-[var(--ds-grey-dark-08)] text-[var(--ds-grey-light-01)]"
            : "bg-[var(--ds-grey-light-02)] text-[var(--ds-grey-dark-09)]",
          multiline
            ? "w-max max-w-[min(240px,70vw)] whitespace-normal leading-[18px] [word-break:break-word]"
            : "whitespace-nowrap leading-[14px]",
          sideClasses(side, align),
        )}
      >
        {content}
      </span>
    </span>
  );
}
