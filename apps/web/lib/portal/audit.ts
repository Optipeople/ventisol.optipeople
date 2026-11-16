// The audit trail: every write and every admin action leaves one row in
// app.audit_log (docs/portal-architecture.md, section 4).
//
// Call audit() inside the same withUser transaction as the write it
// describes, so the two are saved or rolled back together. Who did it is not
// passed in: it is read in SQL from the claims of that transaction, which is
// also what the insert policy checks, so a caller cannot write a row in
// someone else's name.

import type { Db, PortalRole } from "@/lib/db";

/** Free-form extra facts about the action. Must be JSON. */
export type AuditDetail = Record<string, unknown>;

/**
 * Record `action` on `subject` for the user of the surrounding withUser
 * transaction.
 *
 * `action` is a stable dotted code ("portal_user.role_changed"), `subject`
 * the id of the thing acted on.
 */
export async function audit(
  db: Db,
  action: string,
  subject: string | null,
  detail: AuditDetail = {}
): Promise<void> {
  await db.query(
    `insert into app.audit_log (opti_user_id, role, action, subject, detail)
     values (app.current_user_id(), app.current_role(), $1, $2, $3::jsonb)`,
    [action, subject, JSON.stringify(detail)]
  );
}

/**
 * The same, from service code (withService), where there are no claims to
 * read. The actor is named by hand, so only use it for what the portal does
 * on a user's behalf before that user has a role: the first-login row.
 */
export async function auditAsService(
  db: Db,
  actor: { optiUserId: string; role: PortalRole },
  action: string,
  subject: string | null,
  detail: AuditDetail = {}
): Promise<void> {
  await db.query(
    `insert into app.audit_log (opti_user_id, role, action, subject, detail)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [actor.optiUserId, actor.role, action, subject, JSON.stringify(detail)]
  );
}

export type AuditEntry = {
  id: string;
  at: Date;
  optiUserId: string | null;
  role: string | null;
  action: string;
  subject: string | null;
  detail: AuditDetail;
};

/** Newest first. Row level security lets only an admin read the log. */
export async function listAuditLog(db: Db, limit = 100): Promise<AuditEntry[]> {
  const rows = await db.query<{
    id: string | number;
    at: Date | string;
    opti_user_id: string | null;
    role: string | null;
    action: string;
    subject: string | null;
    detail: AuditDetail | null;
  }>(
    `select id, at, opti_user_id, role, action, subject, detail
       from app.audit_log
      order by at desc, id desc
      limit $1`,
    [Math.max(1, Math.min(1000, Math.trunc(limit)))]
  );
  return rows.map((r) => ({
    id: String(r.id),
    at: new Date(r.at),
    optiUserId: r.opti_user_id,
    role: r.role,
    action: r.action,
    subject: r.subject,
    detail: r.detail ?? {},
  }));
}
