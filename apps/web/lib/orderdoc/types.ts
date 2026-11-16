// The production document ("Produktionsliste") 3E writes for an order, as read from its PDF.
// Layout and model: docs/order-documents.md. The same model as the station app's .NET
// OrderDocument, in camelCase and JSON serialisable (it is stored in raw.order_documents.parsed).
// Every part can be missing: a page laid out in a way the parser does not know gives what it
// could read, and `problems` says what it could not.

export interface OrderDocument {
  /** PARSER_VERSION of the parser that made this object. */
  parserVersion: string;
  fileName: string | null;
  pageCount: number;
  header: OrderDocumentHeader;
  positions: OrderPosition[];
  /** What could not be read. Empty for a document read whole. */
  problems: string[];
}

/** The block at the top of every page. Customer and deliveryAddress are the lines as printed, name first. */
export interface OrderDocumentHeader {
  orderNumber: number | null;
  customer: string[];
  deliveryAddress: string[];
  /** "Lev. uge". */
  deliveryWeek: number | null;
  /** "Dato" as an ISO date, "2026-10-22". */
  date: string | null;
  caseHandler: string | null;
  packageInfo: string | null;
  glassDelivery: string | null;
  glassPallet: string | null;
}

/**
 * One position: an element made `quantity` times. It starts at the top of page `pageIndex`
 * (0-based) and runs over `pageCount` pages. `label` is the position as printed ("5", or "5.1"
 * should one appear).
 */
export interface OrderPosition {
  label: string;
  number: number;
  subNumber: number | null;
  system: string | null;
  frameColour: string | null;
  sashColour: string | null;
  sealColour: string | null;
  /** "Antal": how many elements of this position. */
  quantity: number | null;
  frameHoles: string | null;
  notes: string[];
  fields: OrderField[];
  scale: string | null;
  weightKg: number | null;
  sizeWithoutCoupling: ElementSize | null;
  cutting: CutRow[];
  fieldBars: FieldBarRow[];
  hardware: HardwareRow[];
  accessories: HardwareRow[];
  pageIndex: number;
  pageCount: number;
  drawing: PdfBox | null;
}

/** "Mål u/kobling: 1485,0 * 1380,0": width and height in mm, without coupling profiles. */
export interface ElementSize {
  width: number;
  height: number;
  /** As printed: "1485,0 * 1380,0". */
  text: string;
}

/** Width and height in mm read from a printed "1415,0 * 1310,0". */
export interface SizeMm {
  width: number;
  height: number;
}

/**
 * A field (Felt) of the element: its opening, the sash size, the glass and the panes.
 * glassType holds the lines as printed: the glass, then "indv.", "midt.", "udv." and any panel line.
 */
export interface OrderField {
  number: string;
  opening: string | null;
  /** "Rammemål" as printed, null for a fixed field. */
  frameSize: string | null;
  frameSizeMm: SizeMm | null;
  glassType: string[];
  panes: GlassPane[];
  seals: string[];
}

/** One line of Stk / Glasmål / Glasliste for a field. A door field can have two. */
export interface GlassPane {
  quantity: number | null;
  size: string | null;
  sizeMm: SizeMm | null;
  glassList: string | null;
}

/**
 * A line of "Afkortning". `section` is the heading it sits under (Karm, Ramme, Sprosse ...).
 * Lengths stay as printed ("1491,0"); lengthMm is the same as a number.
 */
export interface CutRow {
  section: string;
  profile: string;
  width: string | null;
  quantity: number | null;
  length: string | null;
  lengthMm: number | null;
  side: string | null;
  steel: string | null;
  steelLength: string | null;
  field: string | null;
  clearance: string | null;
}

/** A line of the "Felt / Beskrivelse / Farve" table (glazing bars laid in a field). */
export interface FieldBarRow {
  field: string | null;
  description: string;
  colour: string | null;
  side: string | null;
  length: string | null;
}

/**
 * A line of "Beskrivelse" (hardware), "Tilbehør" (accessories) or a later table laid out the
 * same way, such as "Tilsætningsprofil". `group` is the heading it sits under.
 */
export interface HardwareRow {
  group: string;
  description: string;
  colour: string | null;
  quantity: string | null;
  size: string | null;
  mounting: string | null;
  placement: string | null;
}

/**
 * The drawing on page `pageIndex` of its position, in PDF points with the origin at the bottom
 * left as in the PDF itself, padded 3 pt, with the page size so a viewer can crop a rendered page.
 */
export interface PdfBox {
  left: number;
  bottom: number;
  right: number;
  top: number;
  pageWidth: number;
  pageHeight: number;
}
