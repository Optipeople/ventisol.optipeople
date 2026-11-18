"use server";

// Server actions of Indstillinger. Each one: check the capability (the
// friendly first line), call the data layer in lib/settings (which runs as
// the user, so row level security is the real enforcement, validates with
// zod and audits in the same transaction), then revalidate. They return a
// typed result with a Danish message and never throw for a user error.

import { revalidatePath } from "next/cache";
import { getPortalAccess } from "@/lib/auth";
import type { Claims } from "@/lib/db";
import { onCalendarChanged, onElementTypesChanged, onMaxOpenChanged, onSettingsChanged } from "@/lib/readmodel";
import { can, isPortalRole, type Capability } from "@/lib/portal/roles";
import { SET_ROLE_ERRORS, setPortalUserRole } from "@/lib/portal/users";
import {
  applyBaselineProposal,
  loadBaselineProposal,
  type BaselineProposalResult,
} from "@/lib/settings/baseline";
import {
  removeClosedDay,
  removeShift,
  saveClosedDay,
  saveShift,
  setDeductOffShift,
} from "@/lib/settings/calendar";
import {
  createElementType,
  restoreDefaultElementTypes,
  updateElementType,
} from "@/lib/settings/element-types";
import { fail, FORBIDDEN_MESSAGE, OK, type ActionResult } from "@/lib/settings/result";
import { SETTINGS_PATH } from "@/lib/settings/sections";
import { saveStationChanged, setStationActive } from "@/lib/settings/stations";
import { saveThresholdsChanged } from "@/lib/settings/thresholds";
import { saveTimes } from "@/lib/settings/times";
import { requestRebuildAsAdmin, requestSyncAsAdmin, type AdminRunResult } from "@/lib/sync/status";

const SESSION_MESSAGE = "Din session er udløbet. Genindlæs siden og log ind igen.";
const DEGRADED_MESSAGE = "Din rolle kunne ikke hentes lige nu. Prøv igen om lidt.";
const UNEXPECTED_MESSAGE = "Ændringen kunne ikke gemmes. Prøv igen om lidt.";

/**
 * What a write changes for the rest of the portal: "config" is read by every
 * report page, "settings" only by the pages under Indstillinger.
 */
type Scope = "config" | "settings";

/** Longest a save waits for the read model. The minute sync continues what is left. */
const READ_MODEL_BUDGET_MS = 5000;

/**
 * Brings the stored report figures in line with a configuration change.
 * Runs after the write has committed. A failure here does not undo the save
 * and is not the user's to fix: it is logged, and the next rebuild catches up.
 */
async function refreshReadModel(hook: (now: number) => Promise<unknown>): Promise<void> {
  try {
    await hook(Date.now());
  } catch (error) {
    console.error("Indstillinger: the read model was not refreshed after a save:", error);
  }
}

const calendarChanged = () =>
  refreshReadModel((now) => onCalendarChanged(now, { budgetMs: READ_MODEL_BUDGET_MS }));
const elementTypesChanged = () => refreshReadModel((now) => onElementTypesChanged(now));

async function run(
  capability: Capability,
  scope: Scope,
  write: (claims: Claims) => Promise<ActionResult>,
  /** Called once the write has committed, before the pages are refreshed. */
  committed?: () => Promise<void>
): Promise<ActionResult> {
  try {
    const access = await getPortalAccess();
    if (!access) return fail(SESSION_MESSAGE);
    if (access.roleDegraded) return fail(DEGRADED_MESSAGE);
    if (!can(access.role, capability)) return fail(FORBIDDEN_MESSAGE);

    const result = await write(access.claims);
    if (result.ok) {
      await committed?.();
      // Every write also adds to the audit log, so the settings pages are
      // always refreshed; the report pages only when they read what changed.
      if (scope === "config") revalidatePath("/", "layout");
      else revalidatePath(SETTINGS_PATH, "layout");
    }
    return result;
  } catch (error) {
    console.error("Indstillinger: a write failed unexpectedly:", error);
    return fail(UNEXPECTED_MESSAGE);
  }
}

// --- Brugere ---

export async function changeUserRoleAction(userId: string, role: string): Promise<ActionResult> {
  return run("users.manage", "settings", async (claims) => {
    if (typeof userId !== "string" || !isPortalRole(role)) return fail(SET_ROLE_ERRORS.invalid_role);
    const result = await setPortalUserRole(claims, userId, role);
    return result.ok ? OK : fail(SET_ROLE_ERRORS[result.reason]);
  });
}

// --- Stationer ---

export async function saveStationAction(
  mode: "create" | "update",
  input: unknown
): Promise<ActionResult> {
  // A changed "Max i gang" changes which elements are in progress: rebuild.
  let maxOpenChanged = false;
  return run(
    "masterdata.edit",
    "config",
    async (claims) => {
      const saved = await saveStationChanged(claims, mode === "create" ? "create" : "update", input);
      maxOpenChanged = saved.maxOpenChanged;
      return saved.result;
    },
    async () => {
      if (maxOpenChanged) {
        await refreshReadModel((now) => onMaxOpenChanged(now, { budgetMs: READ_MODEL_BUDGET_MS }));
      }
    }
  );
}

export async function setStationActiveAction(input: unknown): Promise<ActionResult> {
  return run("masterdata.edit", "config", (claims) => setStationActive(claims, input));
}

// --- Elementtyper ---

export async function saveElementTypeAction(
  mode: "create" | "update",
  input: unknown
): Promise<ActionResult> {
  return run(
    "masterdata.edit",
    "config",
    (claims) => (mode === "create" ? createElementType(claims, input) : updateElementType(claims, input)),
    elementTypesChanged
  );
}

export async function restoreDefaultElementTypesAction(): Promise<ActionResult> {
  return run("masterdata.edit", "config", (claims) => restoreDefaultElementTypes(claims), elementTypesChanged);
}

// --- Tider ---

export async function saveTimesAction(kind: unknown, entries: unknown): Promise<ActionResult> {
  return run("times.edit", "config", (claims) => saveTimes(claims, kind, entries));
}

/**
 * "Foreslå fra baseline", step one: the measured medians of the last eight
 * weeks as a proposal to review. Reads only; nothing is saved here.
 */
export async function suggestBaselineAction(): Promise<BaselineProposalResult> {
  try {
    const access = await getPortalAccess();
    if (!access) return fail(SESSION_MESSAGE);
    if (access.roleDegraded) return fail(DEGRADED_MESSAGE);
    if (!can(access.role, "times.edit")) return fail(FORBIDDEN_MESSAGE);
    return await loadBaselineProposal(access.claims, Date.now());
  } catch (error) {
    console.error("Indstillinger: the baseline suggestion failed:", error);
    return fail("Forslaget kunne ikke hentes. Prøv igen om lidt.");
  }
}

/** Step two, "Brug forslag": saves the rows the user kept, through saveTimes. */
export async function applyBaselineAction(kept: unknown): Promise<ActionResult> {
  return run("times.edit", "config", (claims) => applyBaselineProposal(claims, kept));
}

// --- Kalender ---

export async function saveShiftAction(input: unknown): Promise<ActionResult> {
  return run("times.edit", "config", (claims) => saveShift(claims, input), calendarChanged);
}

export async function removeShiftAction(input: unknown): Promise<ActionResult> {
  return run("times.edit", "config", (claims) => removeShift(claims, input), calendarChanged);
}

export async function saveClosedDayAction(input: unknown): Promise<ActionResult> {
  return run("times.edit", "config", (claims) => saveClosedDay(claims, input), calendarChanged);
}

export async function removeClosedDayAction(input: unknown): Promise<ActionResult> {
  return run("times.edit", "config", (claims) => removeClosedDay(claims, input), calendarChanged);
}

export async function setDeductOffShiftAction(value: unknown): Promise<ActionResult> {
  // deduct_off_shift is applied when a report is read: no read model hook.
  return run("times.edit", "config", (claims) => setDeductOffShift(claims, value));
}

// --- Grænseværdier ---

export async function saveThresholdsAction(values: unknown): Promise<ActionResult> {
  let changed: string[] = [];
  return run(
    "times.edit",
    "config",
    async (claims) => {
      const saved = await saveThresholdsChanged(claims, values);
      changed = saved.changed;
      return saved.result;
    },
    () =>
      refreshReadModel((now) => onSettingsChanged(changed, now, { budgetMs: READ_MODEL_BUDGET_MS }))
  );
}

// --- Synkronisering ---

const SYNC_BUSY_MESSAGE = "En synkronisering kører allerede. Prøv igen om lidt.";
const SYNC_BACKGROUND_MESSAGE = "Sat i gang. Den kører videre i baggrunden. Genindlæs siden om lidt.";

/**
 * How an admin run ended, as a result for the buttons. The status rows on
 * the page tell the rest, so they are refreshed after a failed run too.
 */
function syncAnswer(
  outcome: AdminRunResult<{ status: string }>,
  done: string,
  failed: string
): ActionResult {
  if (!outcome.ok) return fail(FORBIDDEN_MESSAGE);
  if (!outcome.finished) return { ok: true, message: SYNC_BACKGROUND_MESSAGE };
  const status = outcome.result.status;
  if (status === "done") return { ok: true, message: done };
  if (status === "busy" || status === "recent") return fail(SYNC_BUSY_MESSAGE);
  revalidatePath(SETTINGS_PATH, "layout");
  return fail(failed);
}

export async function requestSyncAction(): Promise<ActionResult> {
  return run("sync.view", "config", async (claims) =>
    syncAnswer(
      await requestSyncAsAdmin(claims),
      "Synkroniseringen er færdig.",
      "Synkroniseringen fejlede. Se fejlen i tabellen."
    )
  );
}

export async function requestRebuildAction(): Promise<ActionResult> {
  return run("sync.view", "config", async (claims) =>
    syncAnswer(
      await requestRebuildAsAdmin(claims),
      "Genopbygningen er færdig.",
      "Genopbygningen fejlede. Se fejlen i tabellen."
    )
  );
}
