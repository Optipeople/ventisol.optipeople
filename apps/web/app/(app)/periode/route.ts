import { periodeRedirect } from "@/lib/orders-view/params";

// The period report is retired: the finished orders on /ordrer show the same
// period with lead time and status. Old links keep their period and, where
// the finished list has it, their sort. A route handler rather than a page,
// so the answer is a plain 307 (a page under the (app) loading boundary
// would stream and redirect from the client). /ordrer checks the user itself.
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const target = periodeRedirect(Object.fromEntries(url.searchParams));
  return Response.redirect(new URL(target, url), 307);
}
