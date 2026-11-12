import { StatusTag as StatusTagBlock, type StatusTagOption } from "@optipeople/ui/blocks";
import type { OrderStatus } from "@/lib/report";

/** This app's order statuses: label, colour and what the status means. */
const OPTIONS: Record<OrderStatus, StatusTagOption> = {
  active: {
    label: "I gang",
    variant: "warning",
    title: "Et element er scannet ind på en station og ikke ud endnu",
  },
  idle: {
    label: "Ikke i gang",
    variant: "default",
    title: "Intet på ordren er scannet ind på en station lige nu",
  },
};

export function StatusTag({ status }: { status: OrderStatus }) {
  return <StatusTagBlock status={status} options={OPTIONS} />;
}

export function statusLabel(status: OrderStatus): string {
  return OPTIONS[status].label;
}
