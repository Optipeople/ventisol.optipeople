import type { ReactNode } from "react";
import { PortalChrome } from "@/components/portal-chrome";

// The pages of one order or one station: the same chrome as app/(app), but
// no loading.tsx above them. A loading boundary sends its fallback with a
// 200 before the page has run, so notFound() could no longer answer 404
// (node_modules/next/dist/docs/01-app/02-guides/streaming.md, "Status
// codes"). Do not add a loading.tsx here or in the folders below: a page
// checks that its id exists first, and puts any <Suspense> after that check.
export default function DetailLayout({ children }: { children: ReactNode }) {
  return <PortalChrome>{children}</PortalChrome>;
}
