"use client";

import { StationsError } from "@/components/stations/stations-error";

export default function StationPageError({ error, retry }: { error: unknown; retry: () => void }) {
  return <StationsError error={error} retry={retry} />;
}
