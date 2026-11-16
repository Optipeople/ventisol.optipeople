// The 3E production list ("Produktionsliste") PDF: parser, element types and search chunks.
// Pure apart from reading the bytes handed to it. See docs/order-documents.md.

export type * from "./types";
export { PARSER_VERSION } from "./version";
export { parseOrderDocument } from "./parse";
export { type OrderFileName, parseOrderFileName } from "./file-name";
export { type BarcodeParts, parseElementBarcode, positionFor, positionForBarcode } from "./position";
export {
  type ElementTypeId,
  type ElementTypeRule,
  type ExpectedElement,
  type ExpectedElements,
  DEFAULT_ELEMENT_TYPE_RULES,
  ELEMENT_TYPES,
  FALLBACK_ELEMENT_TYPE,
  classifyElementType,
  elementTypeName,
  expectedElements,
} from "./element-types";
export { type SearchChunk, toSearchChunks } from "./chunks";
