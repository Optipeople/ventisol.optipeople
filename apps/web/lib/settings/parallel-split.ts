// config.settings.parallel_split: how split time shares a station's time
// between elements in progress at once (docs/read-model.md §2, Split time).
// Stored in core.*, so a change needs a rebuild (the server action does it).

import { z } from "zod";
import { withUser, type Claims } from "@/lib/db";
import { fail, OK, runWrite, type ActionResult } from "./result";
import { readSettings, writeSetting } from "./store";

export const PARALLEL_SPLIT_KEY = "parallel_split";

export type ParallelSplitChoice = "calculated" | "equal";

export type ParallelSplitSetting = {
  /** The stored choice; "calculated" when it is missing or unknown, as the read model reads it. */
  value: ParallelSplitChoice;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export function getParallelSplit(claims: Claims): Promise<ParallelSplitSetting> {
  return withUser(claims, async (db) => {
    const row = (await readSettings(db, [PARALLEL_SPLIT_KEY])).get(PARALLEL_SPLIT_KEY);
    return {
      value: row?.value === "equal" ? "equal" : "calculated",
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

/** Save the choice. `changed` tells the caller whether a rebuild is needed. */
export async function setParallelSplit(
  claims: Claims,
  value: unknown
): Promise<{ result: ActionResult; changed: boolean }> {
  const parsed = z.enum(["calculated", "equal"]).safeParse(value);
  if (!parsed.success) return { result: fail("Vælg Efter kalkuletid eller Ligeligt."), changed: false };
  let changed = false;
  const result = await runWrite(claims, async (db) => {
    const before = (await readSettings(db, [PARALLEL_SPLIT_KEY])).get(PARALLEL_SPLIT_KEY)?.value;
    if (before === parsed.data) return OK;
    await writeSetting(db, PARALLEL_SPLIT_KEY, parsed.data, before);
    changed = true;
    return OK;
  });
  return { result, changed: result.ok && changed };
}
