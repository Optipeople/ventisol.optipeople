// "Who changed it": OptiCloud user ids to names, as far as the caller may
// see them. An admin sees every portal user, anyone else only their own row
// (row level security), so for a planner most ids stay unnamed.

import type { Claims } from "@/lib/db";
import { listPortalUsers } from "@/lib/portal/users";

export async function portalUserNames(claims: Claims): Promise<Map<string, string>> {
  const users = await listPortalUsers(claims);
  return new Map(users.map((u) => [u.optiUserId, u.name ?? u.email ?? u.optiUserId]));
}

/** Danish text for the user behind `id`: "dig", a name, or "en anden bruger". */
export function whoLabel(
  names: ReadonlyMap<string, string>,
  id: string | null,
  selfId: string
): string {
  if (id === null) return "systemet";
  if (id === selfId) return "dig";
  return names.get(id) ?? "en anden bruger";
}
