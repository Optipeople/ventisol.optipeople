"use client";

import { useState, type ReactNode } from "react";
import { ReportPrintActions, ReportPrintSheet } from "@optipeople/ui/reports";

/**
 * The sheet the Ledelse report lies on. On paper only the sheet prints, on
 * A4, without the portal around it. On screen it fills the page; the first
 * toolbar button switches to the A4 preview and back, the second prints.
 */
export function ReportSheet({ children }: { children: ReactNode }) {
  const [fullWidth, setFullWidth] = useState(true);
  return (
    <ReportPrintSheet
      fullWidth={fullWidth}
      toolbar={<ReportPrintActions fullWidth={fullWidth} onFullWidthChange={setFullWidth} />}
      // At full width the page is the backdrop, so the sheet's own grey frame goes.
      className={fullWidth ? "bg-transparent p-0" : undefined}
    >
      {children}
    </ReportPrintSheet>
  );
}
