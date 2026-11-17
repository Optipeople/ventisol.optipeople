import type { Metadata } from "next";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  Tag,
} from "@optipeople/ui";
import { EmptyState, Notice, SectionCard, TableFrame } from "@optipeople/ui/blocks";
import { SyncActions } from "@/components/settings/sync-actions";
import { requireCapability } from "@/lib/auth";
import { getSyncStatus, type SyncStatusRow } from "@/lib/sync/status";
import { requestRebuildAction, requestSyncAction } from "../actions";
import { formatDateTime, formatDuration, formatInt, requestTime } from "@/lib/time";

export const metadata: Metadata = { title: "Synkronisering" };

// What the known jobs are called in Danish. An unknown job shows its own name.
const JOB_LABELS: Readonly<Record<string, string>> = {
  sync: "Synkronisering i alt",
  scans: "Scanninger",
  documents: "Produktionslister",
  reconcile: "Afstemning",
  rebuild: "Genopbygning",
  readmodel: "Beregnede tal",
  readmodel_rebuild: "Beregnede tal, genopbygning",
};

type State = { label: string; variant: "positive" | "issue" | "warning" };

// How the last run ended, as the job reported it itself.
const STATES: Readonly<Record<string, State>> = {
  ok: { label: "OK", variant: "positive" },
  running: { label: "Kører", variant: "warning" },
  not_configured: { label: "Ikke sat op", variant: "warning" },
  login_backoff: { label: "Login afvist", variant: "issue" },
  unavailable: { label: "OptiCloud svarer ikke", variant: "issue" },
  no_table: { label: "Tabel mangler", variant: "issue" },
  error: { label: "Fejl", variant: "issue" },
};

function status(job: SyncStatusRow): State {
  const reported = job.status === null ? undefined : STATES[job.status];
  if (reported) return reported;
  // The job did not say (or said something unknown): judge by the times.
  if (job.lastSuccessAt === null) {
    return job.error ? STATES.error : { label: "Ikke kørt", variant: "warning" };
  }
  // The last run failed when it is newer than the last success.
  const failed =
    job.error !== null && job.lastRunAt !== null && job.lastRunAt.getTime() > job.lastSuccessAt.getTime();
  return failed ? STATES.error : STATES.ok;
}

const when = (date: Date | null) => (date ? formatDateTime(date.getTime()) : "Aldrig");

export default async function SyncPage() {
  const ctx = await requireCapability("/indstillinger/synkronisering", "sync.view");
  const { configured, missing, jobs, deadLetters } = await getSyncStatus(ctx.claims, requestTime());

  return (
    <SectionCard
      title="Synkronisering med OptiCloud"
      description="Portalen henter scanninger og produktionslister fra OptiCloud og regner rapporternes tal ud fra dem. Her ses, hvornår det sidst skete."
      action={<SyncActions onSync={requestSyncAction} onRebuild={requestRebuildAction} />}
      bodyClassName="p-0"
    >
      {!configured && (
        <div role="status" className="m-6">
          <Notice tone="error" icon>
            Servicekontoen til OptiCloud er ikke sat op, så der kan ikke hentes nye data. Mangler i
            miljøet: {missing.join(", ")}.
          </Notice>
        </div>
      )}
      {deadLetters > 0 && (
        <div role="status" className="m-6">
          <Notice tone="error" icon>
            {deadLetters === 1 ? "1 ordre" : `${deadLetters} ordrer`} kunne ikke regnes ud og er lagt
            til side. Deres tal er forældede, indtil der trykkes Genopbyg.
          </Notice>
        </div>
      )}
      {jobs.length === 0 ? (
        <EmptyState title="Ingen synkronisering har kørt endnu" className="m-6">
          Når den første hentning fra OptiCloud har kørt, står hvert job her med tidspunkt, forsinkelse
          og eventuelle fejl. I eksempeltilstand hentes der ikke noget.
        </EmptyState>
      ) : (
        <TableFrame className="border-0 shadow-none">
          <DataTable>
            <DataTableHead>
              <DataTableHeader>Job</DataTableHeader>
              <DataTableHeader>Status</DataTableHeader>
              <DataTableHeader>Sidst kørt</DataTableHeader>
              <DataTableHeader>Sidst lykkedes</DataTableHeader>
              <DataTableHeader align="right">Forsinkelse</DataTableHeader>
              <DataTableHeader align="right">Rækker i alt</DataTableHeader>
              <DataTableHeader>Seneste fejl</DataTableHeader>
            </DataTableHead>
            <DataTableBody>
              {jobs.map((job) => {
                const state = status(job);
                return (
                  <DataTableRow key={job.name}>
                    <DataTableCell className="font-bold">{JOB_LABELS[job.name] ?? job.name}</DataTableCell>
                    <DataTableCell>
                      <Tag size="small" variant={state.variant}>
                        {state.label}
                      </Tag>
                    </DataTableCell>
                    <DataTableCell className="whitespace-nowrap tabular-nums">{when(job.lastRunAt)}</DataTableCell>
                    <DataTableCell className="whitespace-nowrap tabular-nums">{when(job.lastSuccessAt)}</DataTableCell>
                    <DataTableCell align="right" className="whitespace-nowrap tabular-nums">
                      {job.lagSeconds === null ? "Ingen data endnu" : formatDuration(job.lagSeconds * 1000)}
                    </DataTableCell>
                    <DataTableCell align="right" className="tabular-nums">
                      {job.rowsTotal === null ? "Ingen data endnu" : formatInt(job.rowsTotal)}
                    </DataTableCell>
                    <DataTableCell className="max-w-[320px] break-words text-[13px]">
                      {job.error ?? ""}
                      {job.retryAt && (
                        <span className="block text-[var(--ds-grey-medium-05)]">
                          Næste loginforsøg: {formatDateTime(job.retryAt.getTime())}
                        </span>
                      )}
                    </DataTableCell>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
        </TableFrame>
      )}
    </SectionCard>
  );
}
