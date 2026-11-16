// The read model writer: keeps core.* in step with raw.*.
//
// lib/sync calls these after its own transaction has committed. Each function
// opens its own service transactions (withService cannot be nested), so never
// call them from inside withUser or withService.
//
// PLACEHOLDER: the bodies are filled in by the read model work. The
// signatures are the contract lib/sync is written against.

/** One scan that was inserted or changed in raw.scans by a sync run. */
export interface ChangedScan {
  scanId: string;
  orderNo: number;
  stationNo: number | null;
  barcode: string;
  /** Scan time, epoch milliseconds (UTC). */
  scanTime: number;
}

export interface ApplyResult {
  /** Orders whose derived rows were recomputed. */
  orders: number;
  /** (station, day) pairs whose facts were recomputed. */
  stationDays: number;
}

/** Recompute what new or late scans touch: their orders and station days. */
export async function applyScanChanges(changed: ChangedScan[], now: number): Promise<ApplyResult> {
  void changed;
  void now;
  return { orders: 0, stationDays: 0 };
}

/** Recompute orders whose 3E document arrived or changed (customer, delivery week, expected elements, element types). */
export async function applyDocumentChanges(orderNos: number[], now: number): Promise<ApplyResult> {
  void orderNos;
  void now;
  return { orders: 0, stationDays: 0 };
}

/** Throw away core.* and build it again from raw.*. Safe to run at any time. */
export async function rebuildAll(now: number): Promise<ApplyResult> {
  void now;
  return { orders: 0, stationDays: 0 };
}
