import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

// Mirror the Worker's `?raw` Text-module rule (wrangler.jsonc) so the Node fixture can import the same source.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith("?raw")) return nextResolve(specifier, context);
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith("?raw")) return nextLoad(url, context);
    const text = readFileSync(new URL(url.slice(0, -"?raw".length)), "utf8");
    return { format: "module", source: "export default " + JSON.stringify(text) + ";", shortCircuit: true };
  },
});
