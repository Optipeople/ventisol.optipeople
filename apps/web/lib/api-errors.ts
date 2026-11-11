// What a read from OptiCloud can be refused with. On their own, so both the
// API client (lib/opticloud.ts) and the memory cache (lib/api-cache.ts) can
// tell a refusal of one user's token from a failure everyone would get.

/** 401, the token was refused: send the user through the refresh flow. */
export class ApiAuthError extends Error {}

/** 403, the token is fine but may not read this: no refresh, a clear page. */
export class ApiAccessError extends Error {}

/** The failure is about the token the read was made with, not about OptiCloud. */
export function isTokenRefusal(err: unknown): boolean {
  return err instanceof ApiAuthError || err instanceof ApiAccessError;
}
