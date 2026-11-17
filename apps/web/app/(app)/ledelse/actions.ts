"use server";

// Server actions of the Ledelse tab. Each checks the role first (the friendly
// line), then calls lib/reports, where the database checks again. They answer
// an ActionResult with a Danish message and never throw for a user error.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ZodError } from "zod";
import { aiConfigured, chatModel, chatModelId } from "@/app/api/chat/config";
import { getPortalAccess } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { defaultDraftAllow, draftManagementNotes, type DraftResult } from "@/lib/management-view/draft";
import { isMonth, isMonthOver, noteLines, noteLinesProblem } from "@/lib/management-view/month";
import { audit } from "@/lib/portal/audit";
import { can, hasAnyRole } from "@/lib/portal/roles";
import { clientIp } from "@/lib/rate-limit";
import { freezeMonth, ReportAccessError, saveManagementNotes } from "@/lib/reports";
import { fail, FORBIDDEN_MESSAGE, type ActionResult } from "@/lib/settings/result";

const PATH = "/ledelse";
const SESSION_MESSAGE = "Din session er udløbet. Genindlæs siden og log ind igen.";
const DEGRADED_MESSAGE = "Din rolle kunne ikke hentes lige nu. Prøv igen om lidt.";
const MONTH_MESSAGE = "Ugyldig måned. Genindlæs siden.";

async function access() {
  const a = await getPortalAccess();
  if (!a) return fail(SESSION_MESSAGE);
  if (a.roleDegraded) return fail(DEGRADED_MESSAGE);
  return a;
}

/**
 * Saves "Det vigtigste" and "Til beslutning" of a month, one point per line.
 * saveManagementNotes writes the audit row (management_notes.saved) in the
 * same transaction as the notes.
 */
export async function saveNotesAction(month: string, highlights: string, decisions: string): Promise<ActionResult> {
  try {
    const a = await access();
    if ("ok" in a) return a;
    if (!can(a.role, "ledelse.view")) return fail(FORBIDDEN_MESSAGE);
    if (!isMonth(month) || typeof highlights !== "string" || typeof decisions !== "string") return fail(MONTH_MESSAGE);

    const lines = { highlights: noteLines(highlights), decisions: noteLines(decisions) };
    const fieldErrors: Record<string, string> = {};
    for (const key of ["highlights", "decisions"] as const) {
      const problem = noteLinesProblem(lines[key]);
      if (problem) fieldErrors[key] = problem;
    }
    if (Object.keys(fieldErrors).length > 0) return fail("Ret de markerede felter og prøv igen.", fieldErrors);

    await saveManagementNotes(a.claims, { month, ...lines, now: Date.now() });
    revalidatePath(PATH);
    return { ok: true };
  } catch (error) {
    if (error instanceof ReportAccessError) return fail(FORBIDDEN_MESSAGE);
    if (error instanceof ZodError) return fail("Noterne kunne ikke læses. Tjek længden af hvert punkt.");
    console.error("Ledelse: saving the notes failed:", error);
    return fail("Noterne kunne ikke gemmes. Prøv igen om lidt.");
  }
}

/**
 * "Frys måned": admin only, and only for a month that is over. freezeMonth
 * runs as service and does not audit, so the audit row (snapshot.freeze) is
 * written here as the user, right after.
 */
export async function freezeMonthAction(month: string): Promise<ActionResult> {
  try {
    const a = await access();
    if ("ok" in a) return a;
    if (!hasAnyRole(a.role, ["admin"])) return fail(FORBIDDEN_MESSAGE);
    const now = Date.now();
    if (!isMonth(month)) return fail(MONTH_MESSAGE);
    if (!isMonthOver(month, now)) return fail("Måneden er ikke slut endnu og kan ikke fryses.");

    const result = await freezeMonth(month, now);
    if (!result.written) {
      revalidatePath(PATH);
      return { ok: true, message: "Måneden var allerede frosset." };
    }
    await withUser(a.claims, (db) =>
      audit(db, "snapshot.freeze", `${month}-01`, { frozenAt: result.frozenAt })
    );
    revalidatePath(PATH);
    return { ok: true, message: "Måneden er frosset." };
  } catch (error) {
    console.error("Ledelse: freezing the month failed:", error);
    return fail("Måneden kunne ikke fryses. Prøv igen om lidt.");
  }
}

/**
 * "Lav udkast": the chat model drafts the notes of a month from its report.
 * Saves nothing: the draft fills the editor, and the person saves. The role
 * check, rate limit and usage row are in draftManagementNotes.
 */
export async function draftNotesAction(month: string): Promise<DraftResult> {
  return draftManagementNotes(month, {
    access: getPortalAccess,
    model: chatModel,
    modelId: chatModelId,
    configured: aiConfigured,
    now: Date.now,
    ip: async () => clientIp(await headers()),
    allow: defaultDraftAllow,
  });
}
