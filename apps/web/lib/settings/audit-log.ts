// app.audit_log, paged and filtered, for the Hændelseslog page. Only an
// admin gets rows (row level security).

import { withUser, type Claims } from "@/lib/db";
import type { AuditDetail, AuditEntry } from "@/lib/portal/audit";

export const AUDIT_PAGE_SIZE = 50;

export type AuditFilter = {
  /** OptiCloud user id. Empty or missing: everyone. */
  user?: string;
  /** Exact action code. Empty or missing: every action. */
  action?: string;
  /** 1 based. Out of range is moved to the nearest page. */
  page?: number;
  pageSize?: number;
};

export type AuditLogEntry = AuditEntry & {
  /** Name (or e-mail) of the portal user, when one exists. */
  userName: string | null;
};

export type AuditLogPage = {
  entries: AuditLogEntry[];
  total: number;
  page: number;
  pageCount: number;
  /** Every action code in the log, for the filter. */
  actions: string[];
  /** Every user in the log, for the filter. */
  users: { id: string; name: string }[];
};

/** Newest first. */
export function getAuditLogPage(claims: Claims, filter: AuditFilter = {}): Promise<AuditLogPage> {
  const user = filter.user?.trim() || null;
  const action = filter.action?.trim() || null;
  const pageSize = Math.max(1, Math.min(200, Math.trunc(filter.pageSize ?? AUDIT_PAGE_SIZE)));
  const wantedPage = Number.isFinite(filter.page) ? Math.max(1, Math.trunc(filter.page as number)) : 1;

  return withUser(claims, async (db) => {
    const where = `($1::text is null or l.opti_user_id = $1) and ($2::text is null or l.action = $2)`;
    const counted = await db.query<{ total: number }>(
      `select count(*) as total from app.audit_log l where ${where}`,
      [user, action]
    );
    const total = Number(counted[0]?.total ?? 0);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(wantedPage, pageCount);

    const rows = await db.query<{
      id: string | number;
      at: Date | string;
      opti_user_id: string | null;
      role: string | null;
      action: string;
      subject: string | null;
      detail: AuditDetail | null;
      user_name: string | null;
    }>(
      `select l.id, l.at, l.opti_user_id, l.role, l.action, l.subject, l.detail,
              coalesce(u.name, u.email) as user_name
         from app.audit_log l
         left join app.portal_users u on u.opti_user_id = l.opti_user_id
        where ${where}
        order by l.at desc, l.id desc
        limit $3 offset $4`,
      [user, action, pageSize, (page - 1) * pageSize]
    );

    const actions = await db.query<{ action: string }>(
      "select distinct action from app.audit_log order by action"
    );
    const users = await db.query<{ id: string; name: string | null }>(
      `select distinct l.opti_user_id as id, coalesce(u.name, u.email) as name
         from app.audit_log l
         left join app.portal_users u on u.opti_user_id = l.opti_user_id
        where l.opti_user_id is not null
        order by 2 nulls last, 1`
    );

    return {
      entries: rows.map((r) => ({
        id: String(r.id),
        at: new Date(r.at),
        optiUserId: r.opti_user_id,
        role: r.role,
        action: r.action,
        subject: r.subject,
        detail: r.detail ?? {},
        userName: r.user_name,
      })),
      total,
      page,
      pageCount,
      actions: actions.map((a) => a.action),
      users: users.map((u) => ({ id: u.id, name: u.name ?? u.id })),
    };
  });
}
