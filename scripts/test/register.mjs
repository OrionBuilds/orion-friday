// Registers the resolver/loader hooks for `npm test` (node --test). See ts-app-hooks.mjs for why
// this exists. Wired via the test script's `--import ./scripts/test/register.mjs`.
import { register } from "node:module";

register(new URL("./ts-app-hooks.mjs", import.meta.url));
