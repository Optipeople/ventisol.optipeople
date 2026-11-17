/** The chart green is too light for 12px text on white, so the text takes a darker one. */
const GOOD_TEXT = "#2c7a4b";
import { formatPoints, formatSignedPercent } from "@/lib/reports";
import { changeTone } from "@/lib/overview/filters";

/**
 * The change line under a KPI tile: "−6 % mod forrige periode", green when
 * it is good news, red when it is bad, grey when flat or unknown. The words
 * say the same as the color.
 */
export function KpiChange({
  value,
  unit,
  lowerIsBetter,
}: {
  value: number | null;
  unit: "percent" | "points";
  lowerIsBetter: boolean;
}) {
  if (value == null) return <span>Ingen sammenligning endnu</span>;
  const tone = changeTone(value, lowerIsBetter);
  const text = unit === "percent" ? formatSignedPercent(value) : formatPoints(value);
  const word = tone === "good" ? "bedre" : tone === "bad" ? "dårligere" : "uændret";
  return (
    <span>
      <span
        className={tone === "bad" ? "font-bold text-[var(--ds-red-dark)]" : tone === "good" ? "font-bold" : undefined}
        style={tone === "good" ? { color: GOOD_TEXT } : undefined}
      >
        {text}
      </span>{" "}
      mod forrige periode <span className="sr-only">({word})</span>
    </span>
  );
}
