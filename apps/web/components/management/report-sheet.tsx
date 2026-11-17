"use client";

import type { ReactNode } from "react";
import { ReportPrintSheet } from "@optipeople/ui/reports";

/**
 * The sheet the Ledelse report lies on. On paper only the sheet prints, on
 * A4, without the portal around it. On screen it fills the page. The print
 * button is in the page header.
 */
export function ReportSheet({ children }: { children: ReactNode }) {
  return (
    // At full width the page is the backdrop, so the sheet's own grey frame goes.
    <ReportPrintSheet fullWidth className="bg-transparent p-0">
      {children}
    </ReportPrintSheet>
  );
}
