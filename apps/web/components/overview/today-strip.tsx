import Link from "next/link";
import type { ReactNode } from "react";
import { formatNumber, type TodayStrip as TodayStripData } from "@/lib/reports";

/**
 * The today strip: what is moving on the floor right now. A row of plain
 * figures under the header, not tiles, so it does not compete with the
 * period KPIs.
 */
export function TodayStrip({ today, ordersHref }: { today: TodayStripData; ordersHref: string }) {
  return (
    <section
      aria-label="I dag"
      className="rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] shadow-sm"
    >
      <dl className="grid grid-cols-2 divide-[var(--ds-grey-light-02)] md:grid-cols-4 md:divide-x">
        <Figure label="Ordrer i gang" value={formatNumber(today.ordersInProgress)}>
          {today.ordersAtRisk > 0 ? (
            <Link href={ordersHref} className="font-bold text-[var(--ds-red-dark)] underline-offset-2 hover:underline">
              {today.ordersAtRisk} forsinket eller i risiko
            </Link>
          ) : (
            <>{formatNumber(today.ordersActive)} scannet de sidste 14 dage</>
          )}
        </Figure>
        <Figure label="Pakket i dag" value={formatNumber(today.ordersPackedToday)}>
          {today.elementsPacked === 1 ? "1 element" : `${formatNumber(today.elementsPacked)} elementer`}
        </Figure>
        <Figure label="Elementer igennem i dag" value={formatNumber(today.elementsThrough)}>
          {today.passesToday === 1 ? "1 passage" : `${formatNumber(today.passesToday)} passager`} på stationerne
        </Figure>
        <Figure
          label="Stationer i gang nu"
          value={
            <>
              {formatNumber(today.stationsRunning)}
              <span className="text-[16px] font-normal text-[var(--ds-grey-medium-05)]"> af {formatNumber(today.stationsTotal)}</span>
            </>
          }
        >
          har et element lige nu
        </Figure>
      </dl>
    </section>
  );
}

function Figure({ label, value, children }: { label: string; value: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col px-4 py-3">
      <dt className="text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em] text-[var(--ds-grey-medium-04)]">
        {label}
      </dt>
      <dd className="mt-1 text-[22px] font-bold leading-[26px] tabular-nums text-[var(--ds-grey-dark-09)]">{value}</dd>
      <dd className="text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">{children}</dd>
    </div>
  );
}
