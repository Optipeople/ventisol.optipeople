// pdfjs-dist ships no types for its worker module. It is imported only to hand it to pdfjs.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
