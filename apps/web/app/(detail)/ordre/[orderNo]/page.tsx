import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, EmptyState, KpiRow, KpiTile, PageHeader, PageShell, SectionTitle } from "@optipeople/ui/blocks";
import { DeliveryStatusTag } from "@/components/orders/delivery-status-tag";
import { DeviationNotes } from "@/components/orders/deviation-notes";
import { OrderDocuments } from "@/components/orders/order-documents";
import { ElementsTable, PassesTable } from "@/components/orders/order-tables";
import { RouteGantt, StepsTable } from "@/components/orders/route-gantt";
import { requireCapability } from "@/lib/auth";
import { pickDocument } from "@/lib/orders-view/documents";
import { CLOCK_LABELS, ordersHref } from "@/lib/orders-view/params";
import {
  formatCount,
  formatDayTime,
  formatDuration,
  formatForecast,
  formatNumber,
  getOrderDetail,
  getOrderDocuments,
  NO_DATA,
  type Clock,
  type OrderDocumentInfo,
  type OrderHeader,
} from "@/lib/reports";
import { requestTime } from "@/lib/time";

type Params = Promise<{ orderNo: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

function parseOrderNo(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { orderNo } = await params;
  return { title: `Ordre ${orderNo}` };
}

export default async function OrderPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { orderNo: raw } = await params;
  const search = await searchParams;
  const clockParam = one(search.clock);
  const clock: Clock | undefined = clockParam === "working" || clockParam === "wall" ? clockParam : undefined;
  const wantedDoc = one(search.doc);

  const self = (doc?: string) => {
    const qs = new URLSearchParams();
    if (clock) qs.set("clock", clock);
    if (doc) qs.set("doc", doc);
    return qs.size ? `/ordre/${raw}?${qs}` : `/ordre/${raw}`;
  };
  const ctx = await requireCapability(self(wantedDoc), "reports.view");

  // No loading boundary above this page (app/(detail)/layout.tsx): whether the
  // order exists is only known from the full read, so nothing streams before
  // it and an unknown order is a real HTTP 404.
  const orderNo = parseOrderNo(raw);
  if (orderNo == null) notFound();
  const now = requestTime();
  const detail = await getOrderDetail(ctx.claims, { orderNo, now, clock });
  if (!detail) {
    // No scans yet, but the 3E list may be in: the order is known, just not started.
    const documents = await getOrderDocuments(ctx.claims, { orderNo });
    if (documents.length === 0) notFound();
    return <NotStartedOrder orderNo={orderNo} documents={documents} wantedDoc={wantedDoc} self={self} clock={clock} />;
  }

  const { order } = detail;
  const packed = order.status === "packed";
  const document = pickDocument(detail.documents, wantedDoc);
  const back = ordersHref({ view: packed ? "finished" : "in-progress", clock });

  return (
    <PageShell width="wide">
      <BackLink href={back} label="Ordrer" className="mb-4" />
      <PageHeader
        eyebrow={packed ? "Pakket ordre" : "Ordre i gang"}
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            Ordre {order.orderNo}
            <DeliveryStatusTag status={order.deliveryStatus} label={order.deliveryStatusLabel} />
          </span>
        }
        intro={<OrderIntro order={order} />}
      />

      {packed ? (
        <KpiRow>
          <PackedTiles order={order} />
        </KpiRow>
      ) : (
        // Five tiles: one row on a wide screen, three and two on a narrower one.
        <KpiRow className="lg:grid-cols-3 xl:grid-cols-5">
          <InProgressTiles order={order} />
        </KpiRow>
      )}

      <div className="mt-6">
        <DeviationNotes notes={detail.notes} headline={detail.notesHeadline} />
      </div>

      <SectionTitle
        title="Ruten gennem fabrikken"
        aside={`De syv trin fra start til pakning. Tider i ${CLOCK_LABELS[detail.clock].toLowerCase()}.`}
      />
      <RouteGantt order={order} steps={detail.steps} now={now} />
      <StepsTable steps={detail.steps} />

      <SectionTitle
        title="Passager på stationerne"
        aside={`${formatCount(detail.intervals.length, "passage", "passager")}, ældste først. Ventetid er tiden siden elementets forrige ud-scanning.`}
      />
      {detail.intervals.length > 0 ? (
        <PassesTable intervals={detail.intervals} elements={detail.elements} />
      ) : (
        <EmptyState>Ingen passager er scannet på ordren endnu.</EmptyState>
      )}

      <SectionTitle
        title="Elementer"
        aside={
          order.expectedSource === "document"
            ? `${formatNumber(order.elementsSeen)} scannet af ${formatNumber(order.elementsExpected)} på produktionslisten`
            : `${formatCount(order.elementsSeen, "element", "elementer")} scannet. Ingen produktionsliste.`
        }
      />
      {detail.elements.length > 0 ? (
        <ElementsTable elements={detail.elements} />
      ) : (
        <EmptyState>Ingen elementer er scannet endnu.</EmptyState>
      )}

      <SectionTitle title="Produktionsliste" aside="3E-listen fra OptiCloud" />
      <OrderDocuments orderNo={order.orderNo} documents={detail.documents} selected={document} hrefFor={(f) => self(f)} />

      <p className="mt-6 text-[12px] leading-[18px] text-[var(--ds-grey-medium-05)]">
        Beregnet {formatDayTime(order.computedAt)}.
      </p>
    </PageShell>
  );
}

/** An order with a 3E list and no scans yet: what the list says, and the list itself. */
function NotStartedOrder({
  orderNo,
  documents,
  wantedDoc,
  self,
  clock,
}: {
  orderNo: number;
  documents: OrderDocumentInfo[];
  wantedDoc: string | undefined;
  self: (doc?: string) => string;
  clock: Clock | undefined;
}) {
  const document = pickDocument(documents, wantedDoc);
  const header = documents.find((d) => d.header)?.header ?? null;
  const customer = header?.customer.filter(Boolean)[0] ?? null;
  const pieces = document?.positions.reduce((sum, p) => sum + (p.quantity ?? 0), 0) ?? 0;
  return (
    <PageShell width="wide">
      <BackLink href={ordersHref({ view: "in-progress", clock })} label="Ordrer" className="mb-4" />
      <PageHeader
        eyebrow="Ikke startet"
        title={`Ordre ${orderNo}`}
        intro={[customer ?? "Ukendt kunde", header?.caseHandler ? `sagsbehandler ${header.caseHandler}` : null]
          .filter(Boolean)
          .join(" · ")}
      />
      <KpiRow>
        <KpiTile label="Status" value="Ikke scannet endnu" hint="Produktionslisten er hentet fra OptiCloud" />
        <KpiTile label="Leveringsuge" value={header?.deliveryWeek != null ? `Uge ${header.deliveryWeek}` : "Ingen leveringsuge"} />
        <KpiTile label="Elementer" value={pieces > 0 ? formatNumber(pieces) : NO_DATA} hint="Ifølge produktionslisten" />
      </KpiRow>
      <SectionTitle title="Produktionsliste" aside="3E-listen fra OptiCloud" />
      <OrderDocuments orderNo={orderNo} documents={documents} selected={document} hrefFor={(f) => self(f)} />
    </PageShell>
  );
}

function OrderIntro({ order }: { order: OrderHeader }) {
  const parts = [order.customer ?? "Ukendt kunde", order.caseName ? `sag ${order.caseName}` : null, order.deliveryAddress].filter(
    Boolean
  );
  return <>{parts.join(" · ")}</>;
}

function deadline(order: OrderHeader): { value: string; hint?: string } {
  if (order.deliveryWeek == null) return { value: "Ingen leveringsuge" };
  return { value: `Uge ${order.deliveryWeek}`, hint: order.dueAt ? `Frist ${formatDayTime(order.dueAt)}` : undefined };
}

function elementsHint(order: OrderHeader): string {
  return order.expectedSource === "scans" ? "Uden produktionsliste: kun de scannede" : `${formatNumber(order.elementsSeen)} scannet`;
}

function PackedTiles({ order }: { order: OrderHeader }) {
  const due = deadline(order);
  return (
    <>
      <KpiTile
        label="Gennemløbstid"
        value={formatDuration(order.lead.seconds)}
        hint={order.wait.seconds != null ? `Heraf ventetid ${formatDuration(order.wait.seconds)}` : undefined}
        explain="Fra første scanning til ordren var pakket"
      />
      <KpiTile label="Pakket" value={formatDayTime(order.packedAt)} hint={`Start ${formatDayTime(order.startAt)}`} />
      <KpiTile label="Leveringsuge" value={due.value} hint={due.hint} bad={order.onTime === false} />
      <KpiTile
        label="Elementer pakket"
        value={`${formatNumber(order.elementsPacked)} af ${formatNumber(order.elements)}`}
        hint={elementsHint(order)}
        bad={order.elementsPacked < order.elements}
      />
    </>
  );
}

function InProgressTiles({ order }: { order: OrderHeader }) {
  const due = deadline(order);
  const forecastHint =
    order.forecastReadyAt == null
      ? "Mangler typiske tider"
      : [
          order.forecastRemainingSeconds != null && order.forecastRemainingSeconds >= 60
            ? `${formatDuration(order.forecastRemainingSeconds)} arbejde tilbage`
            : null,
          order.forecastBasis === "seen_elements" ? "kun de scannede elementer" : null,
        ]
          .filter(Boolean)
          .join(", ") || undefined;
  return (
    <>
      <KpiTile label="Er nu ved" value={order.currentLabel} hint={`Seneste scanning ${formatDayTime(order.lastScanAt)}`} />
      <KpiTile
        label="Tid indtil nu"
        value={formatDuration(order.elapsed.seconds)}
        hint={order.wait.seconds != null ? `Heraf ventetid ${formatDuration(order.wait.seconds)}` : undefined}
        explain="Fra første scanning til nu"
      />
      <KpiTile
        label="Forventet klar"
        value={order.forecastReadyAt ? formatForecast(order.forecastReadyAt) : NO_DATA}
        hint={forecastHint}
        bad={order.deliveryStatus === "at_risk" || order.deliveryStatus === "late"}
        explain="Et skøn ud fra de typiske tider på stationerne og de elementer, der mangler"
      />
      <KpiTile label="Leveringsuge" value={due.value} hint={due.hint} bad={order.deliveryStatus === "late"} />
      <KpiTile
        label="Elementer pakket"
        value={`${formatNumber(order.elementsPacked)} af ${formatNumber(order.elements)}`}
        hint={`${formatNumber(order.elementsAssembled)} samlet. ${elementsHint(order)}`}
      />
    </>
  );
}
