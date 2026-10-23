// The site's own address, and the one rule for following a `next` parameter.
// Kept dependency-free so proxy.ts and route handlers can import it.

const DEFAULT_SITE_URL = "https://ventisol.optipeople.dk";

/**
 * Public base URL of this site (SITE_URL), for links that leave the site,
 * such as the password-reset link in an email. Never taken from the request's
 * Host or X-Forwarded-Host headers: anyone can set those.
 */
export function siteUrl(): string {
  const raw = process.env.SITE_URL?.trim() || DEFAULT_SITE_URL;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

/**
 * A `next` parameter as a path on this site, or "/" when it would lead
 * anywhere else. `next` is resolved against `base` (the request URL, or the
 * site URL) the way a browser would, so tricks like `//evil.com`,
 * `/\evil.com` or `https:evil.com` resolve off-origin and are refused. The
 * result keeps only path and query, with leading slashes collapsed so it can
 * never be read as a protocol-relative URL.
 */
export function safeNextPath(next: string | null | undefined, base: string = siteUrl()): string {
  if (!next) return "/";
  let origin: string;
  let url: URL;
  try {
    origin = new URL(base).origin;
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  const path = `${url.pathname.replace(/^\/+/, "/")}${url.search}`;
  return path.startsWith("/") ? path : "/";
}
