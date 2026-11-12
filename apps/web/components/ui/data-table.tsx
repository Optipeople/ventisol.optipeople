import * as React from "react";
import { cn } from "@/lib/utils";

// Admin data table — matches the Figma "Tasks Panel, List View" used
// on the machines and accounts lists in the backoffice. Use this for
// every tabular list; don't reach for raw <table>/<thead>/<th> pairs.
//
// Usage:
//   <DataTable>
//     <DataTableHead>
//       <DataTableHeader>Name</DataTableHeader>
//       <DataTableHeader align="right">Count</DataTableHeader>
//     </DataTableHead>
//     <DataTableBody>
//       <DataTableRow onClick={...}>
//         <DataTableCell className="group-hover:underline">{r.name}</DataTableCell>
//         <DataTableCell align="right" className="tabular-nums">{r.count}</DataTableCell>
//       </DataTableRow>
//     </DataTableBody>
//   </DataTable>

export function DataTable({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <table
      className={cn("w-full border-separate border-spacing-0 text-[14px]", className)}
    >
      {children}
    </table>
  );
}

export function DataTableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr className="text-left">{children}</tr>
    </thead>
  );
}

export function DataTableHeader({
  children,
  align,
  className,
  "aria-sort": ariaSort,
}: {
  children?: React.ReactNode;
  align?: "right";
  className?: string;
  "aria-sort"?: React.AriaAttributes["aria-sort"];
}) {
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn(
        "sticky top-0 z-[1] h-[42px] border-b border-[var(--ds-grey-light-03)] bg-[#f0f5f5] px-[10px] pt-[16px] pb-[6px] text-[14px] font-bold leading-[16px] text-[var(--ds-grey-dark-09)]",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function DataTableBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function DataTableRow({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = Boolean(onClick);
  return (
    <tr
      onClick={onClick}
      className={cn(
        "group h-[36px] transition-colors",
        interactive && "cursor-pointer hover:bg-[var(--ds-table-blue-hover)]",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function DataTableCell({
  children,
  align,
  className,
  colSpan,
  title,
}: {
  children?: React.ReactNode;
  align?: "right";
  className?: string;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={cn(
        "border-b border-[var(--ds-grey-light-02)] px-[10px] py-[6px] text-[14px] leading-[21px] text-[var(--ds-grey-dark-09)]",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}
