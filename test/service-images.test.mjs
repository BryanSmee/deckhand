// Each service's image holds only what its Dockerfile copies: a module that reads a file the
// image doesn't have as it loads (prompts.mjs reads prompts/ and docs/) stops the service at
// start, which the rest of the suite, run from the repository's root, never sees (#919: the
// runner importing sandbox-spec.mjs, once that imported prompts.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// What a build stage makes, as the suite has it in the clone (listener/vendor's bundle).
const STAGES = { "/vendor/graphql.mjs": "listener/vendor/graphql.mjs" };

// The final stage's COPY lines, laid out in `dir` as the image has them.
function layOut(service, dir) {
  const text = readFileSync(join(root, service, "Dockerfile"), "utf8");
  const final = text.slice(text.lastIndexOf("\nFROM "));
  for (const [, args] of final.matchAll(/^COPY (?:--\S+ )*(.+)$/gm)) {
    const parts = args.trim().split(/\s+/);
    const dest = join(dir, parts.pop());
    for (const src of parts) {
      if (src.startsWith("/")) {
        // A build stage's output: the clone's copy when the suite has one (the dashboard's
        // dist/ is served, never imported).
        if (STAGES[src]) cpSync(join(root, STAGES[src]), join(dest, basename(src)));
      } else if (src.includes("*")) {
        const [head, tail] = basename(src).split("*");
        for (const name of readdirSync(join(root, dirname(src)))) {
          if (name.startsWith(head) && name.endsWith(tail)) {
            cpSync(join(root, dirname(src), name), join(dest, name));
          }
        }
      } else if (src.endsWith("/")) {
        cpSync(join(root, src), dest, { recursive: true });
      } else {
        cpSync(join(root, src), join(dest, basename(src)));
      }
    }
  }
}

// Every module of the service but its entry point, which would start listening.
const SERVICES = {
  edge: "server.mjs",
  broker: "server.mjs",
  models: "server.mjs",
  github: "server.mjs",
  runner: "server.mjs",
  orchestrator: "server.mjs",
  "policy-service": "service.mjs",
};

for (const [service, entry] of Object.entries(SERVICES)) {
  test(`the ${service} image: its modules load from what its Dockerfile copies`, (t) => {
    const dir = tempDir(t, `deckhand-image-${service}-`);
    layOut(service, dir);
    const modules = readdirSync(join(dir, service)).filter(
      (name) => name.endsWith(".mjs") && name !== entry,
    );
    // The orchestrator's only module is its entry point: prompts.mjs, which reads files, then.
    const imports = modules.length
      ? modules.map((name) => `await import("./${service}/${name}");`)
      : [`await import("./listener/prompts.mjs");`];
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", imports.join("\n")], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    assert.equal(result.status, 0, result.stderr);
  });
}
