// Session cookie names, shared between the server auth helpers (lib/auth.ts)
// and proxy.ts. Kept dependency-free so proxy can import it.

export const SESSION_COOKIES = {
  /** Optipeople access token (opaque bearer string). */
  token: "ventisol_token",
  /** Optipeople refresh token. */
  refresh: "ventisol_refresh",
  /** Login email, required by the refresh_token grant. */
  email: "ventisol_email",
  /** "1" when the user chose "Husk mig": cookies get a 30-day maxAge. */
  persist: "ventisol_persist",
  /**
   * Set for a minute by /auth/refresh after a refresh. A data read that is
   * still refused while it is set does not refresh again (that would loop):
   * it ends the session instead. See app/auth/refresh/route.ts.
   */
  refreshed: "ventisol_refreshed",
} as const;
