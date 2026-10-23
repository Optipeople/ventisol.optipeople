import { Tag } from "@/components/ui/tag";
import type { OrderStatus } from "@/lib/report";

const LABEL: Record<OrderStatus, string> = {
  packed: "Pakket",
  active: "I gang",
  waiting: "Afventer",
};

const VARIANT = {
  packed: "positive",
  active: "warning",
  waiting: "default",
} as const;

const TITLE: Record<OrderStatus, string> = {
  packed: "Sidste scanning er en ud-scanning på pakning, og intet er i gang",
  active: "Et element er scannet ind på en station og ikke ud endnu",
  waiting: "Intet er i gang lige nu, men ordren er ikke pakket",
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
