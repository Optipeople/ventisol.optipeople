"use client";

// The "Download" button of a page: one button that opens a short list of the
// files the page can be downloaded as. The route handlers (app/api/export)
// do the work and answer each file as an attachment.

import { DropdownButton } from "@optipeople/ui";

export interface ExportMenuItem {
  label: string;
  href: string;
}

/** Starts the download of one file. The page stays where it is. */
function download(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function ExportMenuButton({ label, items }: { label: string; items: ReadonlyArray<ExportMenuItem> }) {
  return (
    <DropdownButton
      align="right"
      size="small"
      buttonText={label}
      options={items.map((item) => ({ value: item.href, label: item.label }))}
      onSelect={download}
    />
  );
}
