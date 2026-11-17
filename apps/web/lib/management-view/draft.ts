// "Lav udkast" on Ledelse (docs/web-portal-plan.md section 4.4): the chat
// model drafts "Det vigtigste" and "Til beslutning" for a month from the
// month report. Nothing is saved here: the draft goes back to the editor,
// and the person edits and saves it.
//
// The model sees only a digest of getMonthReport with every figure already
// formatted the way the page shows it, and is told to use those figures
// only. It has no tools, so it cannot fetch anything else.
//
// Flow: signed in -> admin or ledelse -> AI configured -> month valid ->
// rate limit -> daily token budget (shared with the chat) -> report ->
// model -> ai.usage_events row (no conversation) -> draft.

import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { dailyTokenBudget } from "@/app/api/chat/config";
import { estimateCostUsd } from "@/app/api/chat/pricing";
import { tokensUsedToday } from "@/app/api/chat/store";
import type { PortalAccess } from "@/lib/auth";
import { withUser, type Claims } from "@/lib/db";
import { can, hasAnyRole } from "@/lib/portal/roles";
import { allowAttempt, createAttemptLimits } from "@/lib/rate-limit";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSignedPercent,
  getMonthReport,
  monthTitle,
  NO_DATA,
} from "@/lib/reports";
import type { MonthReport } from "@/lib/reports/types";
import { fail, FORBIDDEN_MESSAGE, type ActionFail } from "@/lib/settings/result";
import { isMonth, MAX_NOTE_LENGTH, noteLines } from "./month";

/** 10 drafts per 10 minutes per user (and IP), 30 per IP. */
export const draftLimits = createAttemptLimits({
  name: "ledelse-draft",
  windowMs: 10 * 60_000,
  ipLimit: 30,
  accountLimit: 10,
});

export const defaultDraftAllow = (ip: string, user: string) => allowAttempt(draftLimits, ip, user);

export const DRAFT_MESSAGES = {
  session: "Din session er udløbet. Genindlæs siden og log ind igen.",
  degraded: "Din rolle kunne ikke hentes lige nu. Prøv igen om lidt.",
  notConfigured: "AI er ikke sat op på denne server.",
  month: "Ugyldig måned. Genindlæs siden.",
  rateLimited: "For mange udkast på kort tid. Prøv igen om lidt.",
  budget: "Dagens forbrug af AI er brugt op. Prøv igen i morgen.",
  failed: "Udkastet kunne ikke laves. Prøv igen om lidt.",
} as const;

export interface DraftDeps {
  access(): Promise<PortalAccess | null>;
  model(): LanguageModel;
  /** Stored in ai.usage_events when the response does not name its model. */
  modelId(): string;
  configured(): boolean;
  now(): number;
  /** The client's IP, for the rate limit. */
  ip(): Promise<string>;
  allow(ip: string, optiUserId: string): Promise<boolean>;
}

export type DraftResult = { ok: true; highlights: string; decisions: string } | ActionFail;

const d = (x: { seconds: number | null }) => formatDuration(x.seconds);

/**
 * The month report as the model sees it: Danish keys, every number already
 * formatted as the page shows it. Kalkule only for a role that may see it.
 */
export function monthDigest(report: MonthReport, opts: { frozen: boolean; includeCosts: boolean }) {
  const { current: now, previous: before, change } = report.kpis;
  const stationsToWatch = report.stations
    .filter((s) => s.hasData && s.status !== "normal")
    .map((s) => ({
      station: s.name,
      status: s.statusLabel,
      tidPrStk: formatMinutes(s.timePerPiece.seconds),
      normaltid: formatMinutes(s.normalSeconds),
      modNormalt: formatSignedPercent(s.deviationPercent),
      stodStille: formatDuration(s.standstillSeconds),
    }));

  return {
    maaned: monthTitle(report.month),
    tal: opts.frozen ? "låst" : "beregnet nu, kan stadig ændre sig",
    tid: report.clock === "working" ? "arbejdstid (kun tid i vagterne)" : "hele døgnet",
    noegletal: {
      ordrerPakket: { denne: formatNumber(now.ordersPacked), foer: formatNumber(before.ordersPacked), aendring: formatSignedPercent(change.ordersPercent) },
      elementerPakket: { denne: formatNumber(now.elementsPacked), foer: formatNumber(before.elementsPacked) },
      gennemloebstidPrOrdre: { denne: d(now.lead), foer: d(before.lead), aendring: formatSignedPercent(change.leadPercent) },
      ventetidPrOrdre: { denne: d(now.wait), foer: d(before.wait), aendring: formatSignedPercent(change.waitPercent) },
      arbejdePrOrdre: { denne: d(now.work), foer: d(before.work) },
      leveretTilTiden: {
        denne: formatPercent(now.onTimePercent),
        foer: formatPercent(before.onTimePercent),
        aendring: formatPoints(change.onTimePoints),
        grundlag: `${formatNumber(now.onTimeOrders)} af ${formatNumber(now.onTimeKnown)} ordrer med leveringsuge`,
      },
      ordrerMedOmarbejde: { denne: formatNumber(now.reworkOrders), foer: formatNumber(before.reworkOrders) },
    },
    flaskehals: {
      saetning: report.bottleneck.sentence,
      trin: report.bottleneck.steps
        .filter((s) => s.source !== "none")
        .map((s) => ({ trin: s.label, tidPrOrdre: d(s.duration), herafVentetid: d(s.wait) })),
      trinUdenData: report.bottleneck.missingSteps,
      ventetidFoerStation: report.bottleneck.stations
        .slice(0, 3)
        .map((s) => ({ station: s.name, gennemsnit: d(s.avgWaitBefore), laengste: d(s.longestWaitBefore) })),
    },
    stationer: { saetning: report.stationAttention.sentence, seHer: stationsToWatch },
    ...(opts.includeCosts
      ? {
          kalkuleModMaalt: {
            graensePct: formatPercent(report.calcVsMeasured.thresholdPercent),
            afvigelser: report.calcVsMeasured.byElementType
              .filter((t) => t.flagged)
              .map((t) => ({
                elementtype: t.elementTypeName,
                kalkule: formatMinutes(t.calculatedSeconds),
                maalt: formatMinutes(t.measuredSeconds),
                afvigelse: formatSignedPercent(t.deviationPercent),
              })),
          },
        }
      : {}),
    manglendeUdScanninger: formatNumber(report.missingScanOuts),
    ugeForUge: report.leadTimeWeekly.map((w) => ({
      uge: w.label,
      ordrerPakket: formatNumber(w.ordersPacked),
      gennemloebstid: d(w.lead),
    })),
  };
}

export const DRAFT_INSTRUCTIONS = `Du skriver et udkast til ledelsens månedsnoter i Ventisols produktionsportal. Ventisol producerer vinduer og døre. Du får månedens tal som JSON fra portalens månedsrapport.

## Regler
- Brug kun tal og navne, der står i data. Skriv tallene præcis som de står; de er allerede formateret. Regn aldrig nye tal ud, og gæt aldrig.
- Står der "${NO_DATA}", har vi ikke tallet. Nævn det ikke som et tal, og skriv aldrig 0 i stedet.
- "Det vigtigste" (highlights): 3 til 5 punkter om månedens vigtigste udvikling, fx nøgletal mod måneden før, flaskehalsen, stationer der skal ses på og kalkule mod målt, når den er med.
- "Til beslutning" (decisions): 0 til 3 punkter. Kun hvor tallene giver anledning til det. Skriv dem som et konkret forslag eller spørgsmål, ledelsen kan tage stilling til.
- Hvert punkt er én eller to korte sætninger. Ingen punkttegn foran, ingen overskrifter, ingen markdown, ingen tankestreger.
- Skriv på dansk, sagligt og konkret, til en ledelse der kender virksomheden.`;

const draftSchema = z.object({
  highlights: z.array(z.string()).describe("Det vigtigste: 3 til 5 punkter, ét pr. element."),
  decisions: z.array(z.string()).describe("Til beslutning: 0 til 3 punkter, ét pr. element."),
});

/** Model lines as the editor's text: one point per line, cleaned, capped. */
export function draftText(lines: string[], max: number): string {
  return noteLines(lines.map((l) => l.replace(/\s*\r?\n\s*/g, " ")).join("\n"))
    .slice(0, max)
    .map((l) => (l.length > MAX_NOTE_LENGTH ? l.slice(0, MAX_NOTE_LENGTH) : l))
    .join("\n");
}

async function recordUsage(
  claims: Claims,
  usage: { model: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number | null }
): Promise<void> {
  await withUser(claims, (db) =>
    db.query(
      `insert into ai.usage_events (opti_user_id, model, input_tokens, output_tokens, cached_tokens, cost_usd)
       values ($1, $2, $3, $4, $5, $6)`,
      [claims.optiUserId, usage.model, usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.costUsd]
    )
  );
}

/** Drafts the notes of `month`. Never throws; a failure is a Danish message. */
export async function draftManagementNotes(month: unknown, deps: DraftDeps): Promise<DraftResult> {
  try {
    const access = await deps.access();
    if (!access) return fail(DRAFT_MESSAGES.session);
    if (access.roleDegraded) return fail(DRAFT_MESSAGES.degraded);
    if (!hasAnyRole(access.role, ["admin", "ledelse"])) return fail(FORBIDDEN_MESSAGE);
    if (!deps.configured()) return fail(DRAFT_MESSAGES.notConfigured);
    if (typeof month !== "string" || !isMonth(month)) return fail(DRAFT_MESSAGES.month);

    const { claims } = access;
    if (!(await deps.allow(await deps.ip(), claims.optiUserId))) return fail(DRAFT_MESSAGES.rateLimited);
    const now = deps.now();
    if ((await tokensUsedToday(claims, now)) >= dailyTokenBudget()) return fail(DRAFT_MESSAGES.budget);

    const { report, frozen } = await getMonthReport(claims, { month, now });
    const digest = monthDigest(report, { frozen, includeCosts: can(access.role, "costs.view") });

    const result = await generateText({
      model: deps.model(),
      instructions: DRAFT_INSTRUCTIONS,
      prompt: `Lav udkastet for ${digest.maaned}. Månedens tal:\n${JSON.stringify(digest, null, 2)}`,
      output: Output.object({ schema: draftSchema }),
      providerOptions: {
        anthropic: { metadata: { userId: claims.optiUserId } },
      },
    });

    const model = result.response?.modelId || deps.modelId();
    const tokens = {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
      cachedTokens: result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
    };
    const costUsd = estimateCostUsd(model, tokens);
    try {
      await recordUsage(claims, { model, ...tokens, costUsd });
    } catch (error) {
      console.error("Ledelse: storing the draft's usage failed:", error);
    }

    return {
      ok: true,
      highlights: draftText(result.output.highlights, 5),
      decisions: draftText(result.output.decisions, 3),
    };
  } catch (error) {
    console.error("Ledelse: the draft failed:", error);
    return fail(DRAFT_MESSAGES.failed);
  }
}
