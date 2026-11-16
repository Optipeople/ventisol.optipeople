import type { ReactNode } from "react";
import { PortalChrome } from "@/components/portal-chrome";

// The tabs. app/(app)/loading.tsx streams a skeleton under this layout for
// every page here that has no loading.tsx of its own. Pages that answer
// notFound() for an unknown id live in app/(detail) instead, outside that
// boundary, so the 404 is a real HTTP 404 (docs/portal-architecture.md §5).
export default function AppLayout({ children }: { children: ReactNode }) {
  return <PortalChrome>{children}</PortalChrome>;
}
