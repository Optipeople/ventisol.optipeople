// The export route handlers' work, kept out of app/ so it is tested
// (vitest collects lib/** only). The routes pass in how to find the signed-in
// user, so this file never touches cookies or next/headers.
//
// Order: 401 without a portal user, 400 for an unknown report, 403 when the
// role may not run it (reportQueriesFor, the same list the chat gets), 429
// over the rate limit, 400 for bad parameters, then the file and one audit
// row (export.xlsx or export.pdf).

import { ZodError } from "zod";
import { withUser, type Claims } from "@/lib/db";
import { audit } from "@/lib/portal/audit";
import { allowAttempt, clientIp, createAttemptLimits, TOO_MANY_ATTEMPTS } from "@/lib/rate-limit";
import { isReportQueryName, ReportAccessError, reportQueriesFor } from "@/lib/reports";
import { buildExport, exportInput, type ExportKind } from "./run";

/** 60 files per 10 minutes from one IP, 30 of them for one user. */
export const exportLimits = createAttemptLimits({
  name: "export",
  windowMs: 10 * 60_000,
  ipLimit: 60,
  accountLimit: 30,
});

export interface ExportDeps {
  /** The signed-in user's portal access, or null. The routes pass getPortalAccess from lib/auth. */
  getAccess: () => Promise<{ claims: Claims } | null>;
  now?: () => number;
  /** Rate limit check; defaults to allowAttempt with exportLimits. */
  allow?: (ip: string, userId: string) => Promise<boolean>;
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Content-Disposition with an ASCII name and the UTF-8 one (RFC 6266). */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function handleExport(request: Request, kind: ExportKind, deps: ExportDeps): Promise<Response> {
  const access = await deps.getAccess();
  if (!access) return text(401, "Du er ikke logget ind.");
  const { claims } = access;

  const url = new URL(request.url);
  const report = url.searchParams.get("report") ?? "";
  if (!isReportQueryName(report)) return text(400, "Ukendt rapport.");
  if (!reportQueriesFor(claims).includes(report)) return text(403, "Din rolle giver ikke adgang til denne rapport.");

  const allow = deps.allow ?? ((ip, user) => allowAttempt(exportLimits, ip, user));
  if (!(await allow(clientIp(request.headers), claims.optiUserId))) {
    return text(429, TOO_MANY_ATTEMPTS, { "retry-after": "60" });
  }

  const now = deps.now?.() ?? Date.now();
  const input = exportInput(report, url.searchParams, now);

  let file;
  try {
    file = await buildExport(claims, report, kind, input, now);
  } catch (err) {
    if (err instanceof ZodError) return text(400, "Ugyldige parametre til rapporten.");
    if (err instanceof ReportAccessError) return text(403, "Din rolle giver ikke adgang til denne rapport.");
    throw err;
  }

  await withUser(claims, (db) =>
    audit(db, `export.${kind}`, report, { params: input, rows: file.rows, capped: file.capped, fileName: file.fileName })
  );

  return new Response(file.body as BodyInit, {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-disposition": attachment(file.fileName),
      "content-length": String(file.body.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
