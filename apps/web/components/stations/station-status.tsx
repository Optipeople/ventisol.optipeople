import { StatusTag, type StatusTagOption } from "@optipeople/ui/blocks";
import type { StationStatusKey } from "@/lib/derive";

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
    title: "Stationen holdt pause længere end grænseværdien inden for vagten",
  },
  no_data: { label: "Ingen data endnu", variant: "default", title: "Ingen scanninger eller maskinedata" },
};

export function StationStatusTag({ status }: { status: StationStatusKey }) {
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
