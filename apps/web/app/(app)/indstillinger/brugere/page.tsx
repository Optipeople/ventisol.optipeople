import type { Metadata } from "next";
import { EmptyState, Notice, SectionCard } from "@optipeople/ui/blocks";
import { UsersTable, type UserRow } from "@/components/settings/users-table";
import { requireCapability } from "@/lib/auth";
import { PORTAL_ROLES, ROLE_LABELS } from "@/lib/portal/roles";
import { listPortalUsers } from "@/lib/portal/users";
import { formatDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Brugere" };

export default async function UsersPage() {
  const ctx = await requireCapability("/indstillinger/brugere", "users.manage");
  const users = await listPortalUsers(ctx.claims);

  const rows: UserRow[] = users.map((u) => ({
    id: u.optiUserId,
    name: u.name,
    email: u.email,
    role: u.role,
    lastSeen: u.lastSeenAt ? formatDateTime(u.lastSeenAt.getTime()) : null,
    created: formatDateTime(u.createdAt.getTime()),
    isSelf: u.optiUserId === ctx.claims.optiUserId,
  }));

  return (
    <div className="flex flex-col gap-6">
      <Notice tone="info">
        Brugere oprettes i OptiCloud, ikke her. Når en bruger på Ventisol-kontoen logger ind i
        portalen første gang, dukker brugeren op på listen med rollen Læser. Derefter kan du give
        en anden rolle. Supportbrugere fra Optipeople er altid administratorer og står kun på
        listen, hvis de har en række her.
      </Notice>

      <SectionCard
        title="Portalens brugere"
        description="Vælg en rolle for at ændre den. Ændringen gælder fra brugerens næste sidevisning."
        bodyClassName="p-0"
      >
        {rows.length > 0 ? (
          <UsersTable
            users={rows}
            roles={PORTAL_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
          />
        ) : (
          <EmptyState title="Ingen brugere endnu" className="m-6">
            Ingen har logget ind i portalen endnu. Bed brugerne logge ind med deres
            OptiCloud-bruger, så kommer de frem her.
          </EmptyState>
        )}
      </SectionCard>

      <SectionCard title="Rollerne">
        <dl className="grid gap-x-6 gap-y-2 text-[14px] leading-[21px] sm:grid-cols-[max-content_1fr]">
          <dt className="font-bold">Administrator</dt>
          <dd>Alt, også brugere, stationer, elementtyper, synkronisering og hændelseslog.</dd>
          <dt className="font-bold">Ledelse</dt>
          <dd>Alle rapporter, også Ledelse med månedsrapporter og kalkuletal. Ingen indstillinger.</dd>
          <dt className="font-bold">Planlægger</dt>
          <dd>Rapporterne samt tider, kalender og grænseværdier under Indstillinger.</dd>
          <dt className="font-bold">Læser</dt>
          <dd>Overblik, Stationer, Ordrer og chat. Ser aldrig kalkuletal.</dd>
        </dl>
      </SectionCard>
    </div>
  );
}
