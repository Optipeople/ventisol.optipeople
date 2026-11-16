// The check every cron route makes first. Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>` when the project has that variable.

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/**
 * Null when the request carries the cron secret, else the response to send.
 * Without CRON_SECRET in the environment every request is refused: an open
 * cron route would let anyone start runs. The comparison is of two SHA-256
 * digests in constant time, so neither the secret nor its length leaks
 * through timing.
 */
export function refuseUnlessCron(request: Request): Response | null {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length === 0) {
    return Response.json({ error: "cron_not_configured" }, { status: 503 });
  }
  const given = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
