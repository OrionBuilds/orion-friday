// Module-resolution hooks for `npm test` (node --test with --experimental-transform-types).
//
// Same job as AGENTOS-CORE/scripts/test/ts-ext-hooks.mjs — the house test setup — extended with
// what an app repo needs on top of it:
//
//   1. "@/…" path alias → src/… . The repo convention comes from tsconfig "paths", which Node's
//      ESM resolver does not read.
//   2. Extensionless relative imports retried as ".ts" / "/index.ts". Source files import
//      extensionless (Next's resolver allows it; a literal ".ts" specifier would be a TS5097
//      error under the app tsconfig), but Node's ESM resolver demands explicit extensions.
//   3. ".tsx" modules are served as EMPTY stubs. The intent catalog's import graph reaches
//      agent-core's React Shell through `export *` re-exports; tests never render UI, and Node's
//      type-transform cannot compile JSX. Stubbing keeps the graph loadable without a bundler.
//      (The stub only provides a default export — fine for `export * from` and
//      `export { default as X } from` re-export chains; if a test one day needs a real named
//      export from a .tsx file, that test needs a bundler-backed runner instead.)
//
// Test-runner only — the app bundles with Next's resolver and never sees this file.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SRC = path.join(fileURLToPath(new URL("../../", import.meta.url)), "src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return tryForms(pathToFileURL(path.join(SRC, specifier.slice(2))).href, context, nextResolve);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const retryable = err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_UNSUPPORTED_DIR_IMPORT";
    if (!retryable || !specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw err;
    return tryForms(specifier, context, nextResolve);
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  return nextLoad(url, context);
}

async function tryForms(base, context, nextResolve) {
  let lastErr;
  for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
    try {
      return await nextResolve(base + suffix, context);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
