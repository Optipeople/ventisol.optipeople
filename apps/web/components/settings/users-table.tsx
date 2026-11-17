"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  Select,
  Spinner,
  useConfirm,
} from "@optipeople/ui";
import { TableFrame } from "@optipeople/ui/blocks";
import { changeUserRoleAction } from "@/app/(app)/indstillinger/actions";
import { FormMessage, useSettingsAction } from "./use-settings-action";

export type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  /** Formatted on the server. Null: never seen. */
  lastSeen: string | null;
  created: string;
  isSelf: boolean;
};

export function UsersTable({
  users,
  roles,
}: {
  users: UserRow[];
  roles: { value: string; label: string }[];
}) {
  const confirm = useConfirm();
  const { pending, result, run } = useSettingsAction({ okText: "Rollen er ændret." });
  const roleLabel = (value: string) => roles.find((r) => r.value === value)?.label ?? value;

  async function change(user: UserRow, role: string) {
    if (role === user.role) return;
    const who = user.name ?? user.email ?? user.id;
    const yes = await confirm({
      title: "Skift rolle?",
      description: `${who} får rollen ${roleLabel(role)} i stedet for ${roleLabel(user.role)}.`,
      confirmLabel: "Skift rolle",
    });
    if (yes) run(() => changeUserRoleAction(user.id, role));
  }

  return (
    <div>
      {pending ? (
        <div className="flex items-center gap-2 px-6 pt-4">
          <Spinner className="h-[14px] w-[14px]" />
        </div>
      ) : (
        <FormMessage result={result} className="mx-6 mt-4" />
      )}
      <TableFrame className="border-0 shadow-none">
        <DataTable>
          <DataTableHead>
            <DataTableHeader>Navn</DataTableHeader>
            <DataTableHeader>E-mail</DataTableHeader>
            <DataTableHeader className="w-[200px]">Rolle</DataTableHeader>
            <DataTableHeader>Sidst set</DataTableHeader>
            <DataTableHeader>Oprettet</DataTableHeader>
          </DataTableHead>
          <DataTableBody>
            {users.map((user) => (
              <DataTableRow key={user.id}>
                <DataTableCell>
                  {user.name ?? "Uden navn"}
                  {user.isSelf && <span className="text-[var(--ds-grey-medium-05)]"> (dig)</span>}
                </DataTableCell>
                <DataTableCell>{user.email ?? ""}</DataTableCell>
                <DataTableCell>
                  <Select
                    aria-label={`Rolle for ${user.name ?? user.email ?? user.id}`}
                    value={user.role}
                    onValueChange={(role) => void change(user, role)}
                    items={roles}
                    disabled={pending}
                  />
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">
                  {user.lastSeen ?? "Aldrig"}
                </DataTableCell>
                <DataTableCell className="whitespace-nowrap tabular-nums">{user.created}</DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </TableFrame>
    </div>
  );
}
