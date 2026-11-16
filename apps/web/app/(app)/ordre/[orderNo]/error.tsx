"use client";

import { OrdersError } from "@/components/orders/orders-error";

export default function OrderPageError({ error, retry }: { error: unknown; retry: () => void }) {
  return <OrdersError error={error} retry={retry} what="ordren" />;
}
