import { StatusTag, type StatusTagOption } from "@optipeople/ui/blocks";
import type { StationStatusKey } from "@/lib/derive";
import { formatDuration } from "@/lib/reports/format";

// The station statuses of lib/derive, as tags and as the dot colours of the
// station tiles. This file only decides colour and the explanation on hover.

const OPTIONS: Record<StationStatusKey, StatusTagOption> = {
  normal: { label: "Normal", variant: "positive", title: "Inden for det normale" },
  slower: {
    label: "Langsommere",
    variant: "warning",
    title: "Tid pr. stk. ligger over det normale med mere end grænseværdien",
  },
  long_dwell: {
    label: "Lang liggetid",
    variant: "warning",
    title: "Et element ventede længere end grænseværdien, før det kom til stationen",
  },
  stood_still: {
    label: "Stod stille",
    variant: "issue",
    title: "Pauserne over grænseværdien fylder mindst en tiendedel af vagten indtil nu",
  },
  no_data: { label: "Ingen data endnu", variant: "default", title: "Ingen scanninger eller maskinedata" },
};

/** `standstillSeconds` puts the length on the tag: "Stod stille 1 t 27 min". */
export function StationStatusTag({
  status,
  standstillSeconds,
}: {
  status: StationStatusKey;
  standstillSeconds?: number | null;
}) {
  if (status === "stood_still" && standstillSeconds) {
    const withLength = {
      ...OPTIONS,
      stood_still: { ...OPTIONS.stood_still, label: `Stod stille ${formatDuration(standstillSeconds)}` },
    };
    return <StatusTag status={status} options={withLength} />;
  }
  return <StatusTag status={status} options={OPTIONS} />;
}

/** The status dot and the tile's edge, from the package's tokens. */
export const STATUS_DOT: Record<StationStatusKey, string> = {
  normal: "var(--color-success)",
  slower: "var(--ds-orange-darkest)",
  long_dwell: "var(--ds-orange-darkest)",
  stood_still: "var(--ds-red-dark)",
  no_data: "var(--ds-grey-light-03)",
};
