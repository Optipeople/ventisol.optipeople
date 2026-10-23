/**
 * One headline figure on a report page. From optipeople.vola, with the hover
 * explanation as a plain title attribute instead of the metric catalogue.
 */
export function KpiTile({
  label,
  value,
  hint,
  explain,
}: {
  label: string;
  value: string;
  hint?: string;
  /** What the figure means, on hover. */
  explain?: string;
}) {
  return (
    <div
      title={explain}
      className="rounded-[2px] border border-[var(--ds-grey-light-02)] bg-[var(--color-surface)] p-4 shadow-sm"
    >
      <p className="text-[12px] leading-[14px] font-bold tracking-[0.02em] text-[var(--ds-grey-medium-04)] uppercase">
        {label}
      </p>
      <p className="mt-1 text-[24px] leading-[28px] font-bold tabular-nums text-[var(--ds-grey-dark-09)]">
        {value}
      </p>
      {hint && (
        <p className="text-[12px] leading-[21px] text-[var(--ds-grey-medium-05)]">{hint}</p>
      )}
    </div>
  );
}

export function KpiRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}
