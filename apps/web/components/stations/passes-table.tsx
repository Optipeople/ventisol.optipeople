import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  Tag,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import type { StationGap } from "@/lib/derive";
import type { TimelineInterval } from "@/lib/reports/types";
import { formatDuration } from "@/lib/reports/format";
import { dayKey, formatClock, formatDateTime } from "@/lib/time";
import { elementLabel } from "./station-timeline";

// The day's passes at one station as a table (the timeline's twin), and the
// pauses in the shift.

const MISSING_REASON: Record<"stale" | "superseded", string> = {
  stale: "Ingen ud-scanning i 36 timer",
  superseded: "Afløst af en senere ind-scanning",
};

function time(iso: string, day: string): string {
  const ms = Date.parse(iso);
  return dayKey(ms) === day ? formatClock(ms) : formatDateTime(ms);
}

function PassStatus({ iv }: { iv: TimelineInterval }) {
  if (iv.status === "open") return <Tag variant="warning" size="small">I gang</Tag>;
  if (iv.status === "missing_out") {
    return (
      <Tag variant="issue" size="small" title={iv.missingReason ? MISSING_REASON[iv.missingReason] : undefined}>
        Mangler ud-scanning
      </Tag>
    );
  }
  return iv.isRework ? (
    <Tag variant="issue" size="small" title={`Gang nr. ${iv.visit ?? 2} på stationen`}>
      Omarbejde
    </Tag>
  ) : (
    <span className="text-[var(--ds-grey-medium-05)]">Færdig</span>
  );
}

export function PassesTable({ day, intervals }: { day: string; intervals: TimelineInterval[] }) {
  // Only a station that had several elements in progress at once has a split time to show.
  const shared = intervals.some(
    (iv) => iv.status === "done" && iv.split.seconds != null && iv.split.seconds !== iv.duration.seconds
  );
  return (
    <TableFrame>
      <DataTable stickyHeader>
        <DataTableHead>
          <DataTableHeader>Ind</DataTableHeader>
          <DataTableHeader>Ud</DataTableHeader>
          <DataTableHeader align="right">Tid</DataTableHeader>
          {shared && (
            <DataTableHeader align="right">
              <span title="Elementets andel af stationens tid, når flere elementer var i gang samtidig">Delt tid</span>
            </DataTableHeader>
          )}
          <DataTableHeader align="right">Ventede før</DataTableHeader>
          <DataTableHeader>Ordre</DataTableHeader>
          <DataTableHeader>Element</DataTableHeader>
          <DataTableHeader>Elementtype</DataTableHeader>
          <DataTableHeader>Status</DataTableHeader>
        </DataTableHead>
        <DataTableBody>
          {intervals.map((iv) => (
            <DataTableRow key={iv.intervalId}>
              <DataTableCell className="whitespace-nowrap tabular-nums">
                {time(iv.startAt, day)}
                {iv.startEstimated && (
                  <span className="text-[var(--ds-grey-medium-05)]" title="Starttid regnet ud fra varigheden">
                    {" "}
                    (anslået)
                  </span>
                )}
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">
                {iv.endAt ? time(iv.endAt, day) : <span className="text-[var(--ds-grey-medium-05)]">Ikke scannet ud</span>}
                {iv.autoStopped && (
                  <span className="text-[var(--ds-grey-medium-05)]" title="Ikke scannet ud: stationen stoppede elementet ved vagtskifte">
                    {" "}
                    (vagtskifte)
                  </span>
                )}
              </DataTableCell>
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {iv.status === "missing_out" ? (
                  <span className="text-[var(--ds-grey-medium-05)]">Ukendt</span>
                ) : (
                  formatDuration(iv.duration.seconds)
                )}
              </DataTableCell>
              {shared && (
                <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                  {iv.status === "missing_out" ? (
                    <span className="text-[var(--ds-grey-medium-05)]">Ukendt</span>
                  ) : (
                    formatDuration(iv.split.seconds)
                  )}
                </DataTableCell>
              )}
              <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                {formatDuration(iv.waitBefore.seconds)}
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap tabular-nums">
                <Link href={`/ordre/${iv.orderNo}`} className="text-[var(--ds-midnight-green)] hover:underline">
                  {iv.orderNo}
                </Link>
              </DataTableCell>
              <DataTableCell className="whitespace-nowrap">{elementLabel(iv)}</DataTableCell>
              <DataTableCell className="whitespace-nowrap">{iv.elementTypeName ?? "Uden type"}</DataTableCell>
              <DataTableCell className="whitespace-nowrap">
                <PassStatus iv={iv} />
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </TableFrame>
  );
}

export function GapsList({ gaps, day }: { gaps: StationGap[]; day: string }) {
  return (
    <ul className="flex flex-wrap gap-3">
      {gaps.map((gap) => (
        <li
          key={gap.startAt}
          className="rounded-[var(--ds-radius-control)] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] px-4 py-2 text-[13px] leading-[18px] tabular-nums"
        >
          {time(gap.startAt, day)} til {time(gap.endAt, day)}
          <span className="ml-2 font-bold">{formatDuration(gap.seconds)}</span>
        </li>
      ))}
    </ul>
  );
}
