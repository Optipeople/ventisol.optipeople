import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, KpiRow, KpiTile, Notice, PageHeader, PageShell, SectionTitle } from "@optipeople/ui/blocks";
import { ReadNotice } from "@/components/read-notice";
import { ElementsTable, StationsTable } from "@/components/report-tables";
import { StatusTag } from "@/components/status-tag";
import { Timeline } from "@/components/timeline";
import { requireUser } from "@/lib/auth";
import { formatCount, formatDateTime, formatDuration, formatInt, requestTime } from "@/lib/time";
import { loadOrderReport } from "@/lib/views";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orderNo: string }>;
}): Promise<Metadata> {
  const { orderNo } = await params;
  return { title: `Ordre ${orderNo}` };
}

export default async function OrderPage({
  params,
}: {
  params: Promise<{ orderNo: string }>;
}) {
  const { orderNo: raw } = await params;
  if (!/^\d{1,9}$/.test(raw)) notFound();
  const orderNo = Number(raw);
  const ctx = await requireUser(`/ordre/${raw}`);

  const now = requestTime();
  const report = await loadOrderReport(ctx, orderNo, now);
  const { summary } = report;

  return (
    <PageShell width="wide">
      <p className="mb-3 text-[14px] leading-[21px]">
        <Link href="/" className="text-[var(--ds-midnight-green)] hover:underline">
          ‹ Dagsoverblik
        </Link>
      </p>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            Ordre {orderNo}
            {summary && <StatusTag status={summary.status} />}
          </span>
        }
        intro={`Alle scanninger de seneste ${report.lookbackDays} dage. Omarbejde tæller med i tiden.`}
      />

      {report.incomplete ? (
        <Notice prominent className="mt-5">
          Der er for mange scanninger til at hente ordren, så tallene vises ikke. Prøv igen senere.
        </Notice>
      ) : !summary ? (
        <EmptyState>
          Ingen scanninger for ordre {orderNo} de seneste {report.lookbackDays} dage.
        </EmptyState>
      ) : (
        <>
          <KpiRow>
            <KpiTile
              label="Tid i alt"
              value={formatDuration(summary.totalMs)}
              hint={summary.activeAt.length > 0 ? `I gang på ${summary.activeAt.join(", ")}` : undefined}
              explain="Summen over alle elementer og stationer, fra ind til ud"
            />
            <KpiTile
              label="Elementer"
              value={formatInt(summary.elements)}
              hint={
                summary.elements > 0
                  ? `${formatDuration(summary.totalMs / summary.elements)} pr. element`
                  : undefined
              }
            />
            <KpiTile
              label="Første scanning"
              value={formatDateTime(summary.firstScan)}
              hint={`${summary.days.length} ${summary.days.length === 1 ? "dag" : "dage"} i arbejde`}
            />
            <KpiTile
              label="Sidste scanning"
              value={summary.status === "active" ? "Nu" : formatDateTime(summary.lastScan)}
              hint={
                summary.reworkPasses > 0
                  ? `${summary.reworkPasses} omarbejde-${summary.reworkPasses === 1 ? "passage" : "passager"}`
                  : undefined
              }
            />
          </KpiRow>

          <SectionTitle title="Tidslinje" aside="En bane pr. station, en bjælke fra ind til ud" />
          <Timeline days={report.timeline} />

          <SectionTitle title="Elementer" aside={formatCount(report.elements.length, "element", "elementer")} />
          <ElementsTable elements={report.elements} />

          <SectionTitle title="Stationer" aside="Tid på ordren pr. station" />
          <StationsTable stations={report.stations} showUtilisation={false} />
        </>
      )}

      {!report.incomplete && <ReadNotice read={report.read} />}
    </PageShell>
  );
}
