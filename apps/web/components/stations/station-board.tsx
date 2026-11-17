import Link from "next/link";
import type { StationAttention, StationRow } from "@/lib/reports";
import { formatMinutes, formatNumber, formatSignedPercent, NO_DATA } from "@/lib/reports";
import { StationStatusTag, STATUS_DOT } from "./station-status";

// The station tiles at the top of the Stationer day view: the attention
// sentence as their headline, one tile per station with its status, count
// and time per piece against normal. The numbers in full are in the table
// below. Light @optipeople/ui look, like the rest of the portal.

/** Above this many flagged stations the headline counts them instead of naming them. */
const NAMED_AT_MOST = 3;

/**
 * The attention headline: the report's sentence while it names few stations,
 * otherwise "6 af 7 stationer afviger fra det normale". The tiles and the
 * table mark each one.
 */
export function attentionHeadline(attention: StationAttention, total: number): string {
  if (attention.count <= NAMED_AT_MOST) return attention.sentence;
  return `${attention.count} af ${total} stationer afviger fra det normale`;
}

function Tile({ row, href }: { row: StationRow; href: string }) {
  const flagged = row.status !== "normal" && row.status !== "no_data";
  return (
    <Link
      href={href}
      className={`flex min-h-[132px] flex-col gap-3 rounded-[2px] border bg-[var(--color-surface)] p-4 shadow-sm transition-colors hover:bg-[var(--ds-table-blue-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ds-green-80)] ${
        flagged ? "border-l-4" : "border-[var(--ds-grey-light-02)]"
      }`}
      style={flagged ? { borderColor: "var(--ds-grey-light-02)", borderLeftColor: STATUS_DOT[row.status] } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-[20px] text-[var(--ds-grey-dark-09)]">{row.name}</p>
          <p className="truncate text-[12px] leading-[16px] text-[var(--ds-grey-medium-05)]">
            {row.kindLabel}
            {(row.openCount ?? 0) > 0 ? ` · ${row.openCount} i gang` : ""}
          </p>
        </div>
        <span
          aria-hidden
          className="mt-[5px] h-[10px] w-[10px] shrink-0 rounded-full"
          style={{ background: STATUS_DOT[row.status] }}
        />
      </div>

      {row.hasData ? (
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[24px] font-bold leading-[28px] tabular-nums text-[var(--ds-grey-dark-09)]">
              {formatNumber(row.countThrough)}
            </p>
            <p className="text-[12px] leading-[16px] text-[var(--ds-grey-medium-05)]">stk. igennem</p>
          </div>
          <div className="text-right">
            <p
              className={`text-[15px] font-bold leading-[20px] tabular-nums ${
                row.status === "slower" ? "text-[var(--ds-red-dark)]" : "text-[var(--ds-grey-dark-09)]"
              }`}
            >
              {formatMinutes(row.timePerPiece.seconds)}
            </p>
            <p className="text-[12px] leading-[16px] tabular-nums text-[var(--ds-grey-medium-05)]">
              {row.normalSeconds == null
                ? "intet normalt"
                : `normalt ${formatMinutes(row.normalSeconds)}${
                    row.deviationPercent == null ? "" : `, ${formatSignedPercent(row.deviationPercent)}`
                  }`}
            </p>
          </div>
        </div>
      ) : (
        <p className="flex min-h-[44px] items-end text-[13px] leading-[18px] text-[var(--ds-grey-medium-05)]">{NO_DATA}</p>
      )}

      {/* One line, never wrapping: every tile has the same rows at the same height. */}
      <div className="flex items-center justify-between gap-2 whitespace-nowrap">
        <StationStatusTag status={row.status} />
        {(row.missingScanOutCount ?? 0) > 0 && (
          <span className="truncate text-[12px] font-bold leading-[16px] text-[var(--ds-orange-text)]">
            {row.missingScanOutCount} mangler ud-scanning
          </span>
        )}
      </div>
    </Link>
  );
}

export function StationBoard({
  rows,
  attention,
  hrefFor,
  caption,
}: {
  rows: StationRow[];
  attention: StationAttention;
  hrefFor: (row: StationRow) => string;
  /** A short line beside the headline: the day, live or not. */
  caption?: string;
}) {
  const ok = attention.count === 0;
  return (
    <section aria-label="Stationer på dagen">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="flex items-center gap-2 text-[17px] font-bold leading-[24px] text-[var(--ds-grey-dark-09)]">
          <span
            aria-hidden
            className="h-[10px] w-[10px] shrink-0 rounded-full"
            style={{ background: ok ? STATUS_DOT.normal : STATUS_DOT.slower }}
          />
          {attentionHeadline(attention, rows.length)}
        </h2>
        {caption && <p className="text-[13px] leading-[18px] text-[var(--ds-grey-medium-05)]">{caption}</p>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rows.map((row) => (
          <Tile key={row.stationNo} row={row} href={hrefFor(row)} />
        ))}
      </div>
    </section>
  );
}
