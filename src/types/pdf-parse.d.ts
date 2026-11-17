// Ambient types for the pdf-parse LIB subpath. We import "pdf-parse/lib/pdf-parse.js" directly —
// the package's index.js runs a debug-mode self-test that reads a bundled test PDF from disk at
// import time (breaks under Next bundling); the lib subpath skips that but ships no types.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
  export default pdfParse;
}
