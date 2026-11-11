import { Tag } from "@/components/ui/tag";
import type { OrderStatus } from "@/lib/report";

const LABEL: Record<OrderStatus, string> = {
  active: "I gang",
  idle: "Ikke i gang",
};

const VARIANT = {
  active: "warning",
  idle: "default",
} as const;

const TITLE: Record<OrderStatus, string> = {
  active: "Et element er scannet ind på en station og ikke ud endnu",
  idle: "Intet på ordren er scannet ind på en station lige nu",
};

export function StatusTag({ status }: { status: OrderStatus }) {
  return (
    <Tag variant={VARIANT[status]} size="small" title={TITLE[status]}>
      {LABEL[status]}
    </Tag>
  );
}

export function statusLabel(status: OrderStatus): string {
  return LABEL[status];
}
