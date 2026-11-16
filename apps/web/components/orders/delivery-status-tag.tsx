import { StatusTag, type StatusTagOption } from "@optipeople/ui/blocks";
import type { DeliveryStatusKey } from "@/lib/reports/types";

const VARIANTS: Record<DeliveryStatusKey, StatusTagOption["variant"]> = {
  on_time: "positive",
  at_risk: "warning",
  late: "issue",
  unknown: "default",
};

const TITLES: Record<DeliveryStatusKey, string> = {
  on_time: "Pakket, eller forventet pakket, før leveringsfristen",
  at_risk: "Forventet klar efter leveringsfristen",
  late: "Leveringsfristen er overskredet",
  unknown: "Ingen leveringsuge eller ingen prognose",
};

/** Til tiden, Risiko for forsinkelse, Forsinket, or unknown. The label comes from lib/reports. */
export function DeliveryStatusTag({ status, label }: { status: DeliveryStatusKey; label: string }) {
  const options = { [status]: { label, variant: VARIANTS[status], title: TITLES[status] } } as Record<
    DeliveryStatusKey,
    StatusTagOption
  >;
  return <StatusTag status={status} options={options} />;
}
