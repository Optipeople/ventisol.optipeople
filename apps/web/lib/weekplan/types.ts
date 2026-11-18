// The week plan: the orders of one production week as read from the week's
// 3E database (the "Uge 48.MDB" file the office exports), in the shape the
// three office sheets need. Docs: docs/ugeplan.md.
//
// The browser reads the MDB (lib/weekplan/mdb.ts) and posts this object to
// /api/ugeplan, which adds the portal's own production status and returns the
// workbook (lib/weekplan/workbook.ts). The file itself never leaves the PC:
// it is 25 MB and more, and only these few fields are needed.

import { z } from "zod";

/**
 * The element types of the BKS sheet, in its column order. "FK S" is a fixed
 * frame in the SV & SJV system, "FK DL" one in Danline, "DB" a frame with two
 * or more sashes. T26 to T41 are the Scan types.
 */
export const ELEMENT_TYPES = [
  "SV",
  "FK S",
  "SD",
  "DB SD",
  "FD/ID",
  "DB FD/ID",
  "TD",
  "DB TD",
  "DK TD",
  "DB DK TD",
  "FK",
  "DK",
  "DB DK",
  "KS dør",
  "TS",
  "DB TS",
  "FK DL",
  "SH",
  "DB SH",
  "TV",
  "T26",
  "T10",
  "T16",
  "T20",
  "T41",
] as const;

export type ElementType = (typeof ELEMENT_TYPES)[number];

/** What the frame's leading part is, for the sheets that group finer than the type (Kim's ID and FD). */
export const FRAME_BASES = ["SV", "FK", "ID", "FD", "TD", "DK", "TS", "SH", "T"] as const;
export type FrameBase = (typeof FRAME_BASES)[number];

/** Frames of one type in one order. */
export interface TypeCount {
  type: ElementType;
  base: FrameBase;
  count: number;
}

export interface WeekPlanOrder {
  orderNo: number;
  customer: string;
  /** Initials of the case handler ("fbv"), else the name as 3E has it. */
  responsible: string;
  /** Order sum before VAT, DKK. */
  amount: number | null;
  /** Free field 6 of the order: special hardware and such. */
  remark: string | null;
  /** Free field 2 or 3 is "ja". */
  foilApproved: boolean;
  /** Free field 4 ("Bestilt"), the HTM panels. */
  htm: string | null;
  /**
   * Hours: 3E's Σ Stück × PosZeit, or from the portal the calculated time of
   * the elements. Null when the role may not see calculated times.
   */
  hours: number | null;
  /** The series (batch) numbers of the positions, ascending. */
  batches: number[];
  /** The text of the order's freight position: "Fragt / forsendelse", "Afhentning lavt pakket på palle". */
  freight: string | null;
  /** Frames counted by type. */
  types: TypeCount[];
  /** Σ Stück × frames. */
  elements: number;
  /** Σ Stück × (frames + sashes): one weld per frame and per sash. */
  welds: number;
  /** "Lev. uge" of the order as 3E has it, yyww: 2648. */
  week: number | null;
  /** Positions the classifier could not place: their first text line. */
  unknown: string[];
  /** Loose panels and the like: positions that are no element. */
  looseParts: number;
  /** Where the order came from: the production lists, the 3E file, or both. Set on the server. */
  source?: OrderSource;
}

export type OrderSource = "portal" | "3e" | "begge";

export interface WeekPlan {
  /** The production week most orders are planned in. */
  year: number | null;
  week: number | null;
  /** The MDB's file name, for the info sheet. */
  fileName: string | null;
  orders: WeekPlanOrder[];
}

const typeCount = z.object({
  type: z.enum(ELEMENT_TYPES),
  base: z.enum(FRAME_BASES),
  count: z.number().int().min(0).max(100_000),
});

const text = (max: number) => z.string().max(max);

export const weekPlanOrderSchema = z.object({
  orderNo: z.number().int().min(1).max(99_999_999),
  customer: text(200),
  responsible: text(100),
  amount: z.number().finite().nullable(),
  remark: text(2000).nullable(),
  foilApproved: z.boolean(),
  htm: text(200).nullable(),
  hours: z.number().finite().min(0).nullable(),
  batches: z.array(z.number().int()).max(100),
  freight: text(500).nullable(),
  types: z.array(typeCount).max(ELEMENT_TYPES.length * FRAME_BASES.length),
  elements: z.number().int().min(0),
  welds: z.number().int().min(0),
  week: z.number().int().nullable(),
  unknown: z.array(text(200)).max(500),
  looseParts: z.number().int().min(0),
});

export const weekPlanSchema = z.object({
  year: z.number().int().min(2000).max(2100).nullable(),
  week: z.number().int().min(1).max(53).nullable(),
  fileName: text(260).nullable(),
  orders: z.array(weekPlanOrderSchema).max(2000),
});
