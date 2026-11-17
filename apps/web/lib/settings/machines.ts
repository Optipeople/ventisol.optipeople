// The machines of the account in OptiCloud, for linking a station to one.
// Read with the signed-in user's own token (GET /api/Machine/GetByAccountId),
// the same call the station app makes. The list is a convenience: when it
// cannot be read the form falls back to typing the id, so nothing here throws.

import { API_URL } from "@/lib/auth";
import { fixturesEnabled } from "@/lib/fixtures-flag";

export type OptiCloudMachine = { id: string; name: string };

export type MachineList =
  | { status: "ok"; machines: OptiCloudMachine[] }
  | { status: "unavailable" };

/** Short: the page waits for this, and it can do without the answer. */
const TIMEOUT_MS = 5_000;

const FIXTURE_MACHINES: OptiCloudMachine[] = [10, 20, 30, 40, 50, 60, 70].map((n) => ({
  id: `00000000-0000-4000-8000-0000000000${n}`,
  name: `Linje 1, station ${n}`,
}));

/** The machine list out of the answer's `data`: an array, or an object holding one. */
export function parseMachines(data: unknown): OptiCloudMachine[] {
  let list: unknown[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object") {
    for (const key of ["machines", "items", "rows"]) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        list = value;
        break;
      }
    }
  }
  const machines: OptiCloudMachine[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    machines.push({ id, name: typeof name === "string" && name.trim() ? name.trim() : id });
  }
  return machines.sort((a, b) => a.name.localeCompare(b.name, "da", { numeric: true }));
}

/** The account's machines, sorted by name. */
export async function listOptiCloudMachines(token: string, accountId: string): Promise<MachineList> {
  if (fixturesEnabled()) return { status: "ok", machines: FIXTURE_MACHINES };
  if (!token) return { status: "unavailable" };
  try {
    const res = await fetch(`${API_URL}/api/Machine/GetByAccountId/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`listOptiCloudMachines: OptiCloud answered ${res.status}.`);
      return { status: "unavailable" };
    }
    const body = (await res.json()) as { data?: unknown; errors?: unknown[] | null } | null;
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      console.error("listOptiCloudMachines: OptiCloud returned errors.");
      return { status: "unavailable" };
    }
    return { status: "ok", machines: parseMachines(body?.data) };
  } catch {
    // The cause can hold the request, and so the token: not logged.
    console.error("listOptiCloudMachines: OptiCloud could not be reached.");
    return { status: "unavailable" };
  }
}
