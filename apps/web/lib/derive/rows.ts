// The mechanical step from a derived row to a core.* row: camelCase field to
// snake_case column, jsonb fields as JSON text. Pure, so the writer in
// lib/sync only has to build the insert.

export const CORE_TABLES = {
  orders: "core.orders",
  elements: "core.elements",
  stationIntervals: "core.station_intervals",
  orderSteps: "core.order_steps",
  stationDayFacts: "core.station_day_facts",
} as const;

export type CoreTable = keyof typeof CORE_TABLES;

/** Fields stored as jsonb. Everything else is a scalar or a Postgres array (integer[]). */
export const JSONB_FIELDS: Record<CoreTable, readonly string[]> = {
  orders: ["missingElements"],
  elements: [],
  stationIntervals: [],
  orderSteps: [],
  stationDayFacts: ["gaps", "byElementType"],
};

export function toSnake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Column names and parameter values of one row, in field order. */
export function toDbRow(table: CoreTable, row: object): { columns: string[]; values: unknown[] } {
  const json = JSONB_FIELDS[table];
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(row)) {
    columns.push(toSnake(field));
    values.push(json.includes(field) && value != null ? JSON.stringify(value) : value);
  }
  return { columns, values };
}

/** `insert into core.x (a, b) values ($1, $2)` for one row. */
export function insertSql(table: CoreTable, row: object): { sql: string; values: unknown[] } {
  const { columns, values } = toDbRow(table, row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  return { sql: `insert into ${CORE_TABLES[table]} (${columns.join(", ")}) values (${placeholders})`, values };
}
