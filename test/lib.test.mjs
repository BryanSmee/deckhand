// lib/ is what every service's image copies (AGENTS.md, Layout): it imports node's modules and
// its own, never a service's code nor a package.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const lib = join(import.meta.dirname, "..", "lib");

test("lib/ imports node: and lib/ only", () => {
  for (const file of readdirSync(lib).filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(join(lib, file), "utf8");
    // `from "…"` and `import "…"` or `import("…")`: not `Buffer.from("…")`.
    for (const [, spec] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)"([^"]+)"/g)) {
      assert.match(spec, /^(node:|\.\/[\w-]+\.mjs$)/, `${file} imports ${spec}`);
    }
  }
});
