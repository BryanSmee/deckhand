// Each service's image holds only what its Dockerfile copies: a module that reads a file the
// image doesn't have as it loads (prompts.mjs reads prompts/ and docs/) stops the service at
// start, which the rest of the suite, run from the repository's root, never sees (#919: the
// runner importing sandbox-spec.mjs, once that imported prompts.mjs). Loading the modules
// misses what only runs later (the entry point's own imports, an import() in a function, a file
// read on a call), so each image's import graph is walked too, from its entry point (#924).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { posix, tempDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// What a build stage makes, as the suite has it in the clone (listener/vendor's bundle).
const STAGES = { "/vendor/graphql.mjs": "listener/vendor/graphql.mjs" };

// The final stage's COPY lines, laid out in `dir` as the image has them.
function layOut(service, dir) {
  const text = readFileSync(join(root, service, "Dockerfile"), "utf8");
  // A line that ends with a backslash goes on with the next one (the proxy's long COPY).
  const final = text.slice(text.lastIndexOf("\nFROM ")).replace(/\\\r?\n/g, " ");
  for (const [, args] of final.matchAll(/^COPY (?:--\S+ )*(.+)$/gm)) {
    const parts = args.trim().split(/\s+/);
    const dest = join(dir, parts.pop());
    for (const src of parts) {
      if (src.startsWith("/")) {
        // A build stage's output: the clone's copy when the suite has one (the dashboard's
        // dist/ is served, never imported: there, so that the walk finds it).
        if (STAGES[src]) cpSync(join(root, STAGES[src]), join(dest, basename(src)));
        else mkdirSync(src.endsWith("/") ? dest : join(dest, basename(src)), { recursive: true });
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
  proxy: "proxy.mjs",
};

// What a module names by a path of its own: its imports and re-exports, an import() of a
// literal, and the files it reads through new URL(…, import.meta.url) (a template's: the folder
// before its first ${}). Whole-line // comments are left out, as they quote code
// (not /* */: the services have none, and their strings and regexes hold /* often).
function references(source) {
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  for (const [, spec] of code.matchAll(
    /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g,
  )) {
    found.push(spec);
  }
  for (const [, spec] of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.push(spec);
  for (const [, spec] of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(spec);
  for (const [, quoted, template] of code.matchAll(
    /new URL\(\s*(?:["']([^"']+)["']|`([^`$]*)(?:\$\{[^`]*)?`)\s*,\s*import\.meta\.url\s*\)/g,
  )) {
    found.push(
      quoted ?? (template.includes("/") ? template.slice(0, template.lastIndexOf("/") + 1) : "./"),
    );
  }
  return found.filter((spec) => spec.startsWith("."));
}

// Every file the image's modules name, from `entry` on, that the image doesn't have, with the
// module naming it: paths relative to the image's /app.
function missing(dir, entry) {
  const absent = [];
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of references(readFileSync(file, "utf8"))) {
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) {
        absent.push(`${posix(relative(dir, target))} (${posix(relative(dir, file))}: "${spec}")`);
      } else if (extname(target) === ".mjs") {
        walk(target);
      }
    }
  };
  walk(join(dir, entry));
  return absent;
}

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

for (const [service, entry] of Object.entries(SERVICES)) {
  test(`the ${service} image: every file its modules name is one its Dockerfile copies`, (t) => {
    const dir = tempDir(t, `deckhand-image-${service}-`);
    layOut(service, dir);
    assert.deepEqual(missing(dir, join(service, entry)), []);
  });
}

test("the walk finds an import, an import(), a worker and a file read the image lacks", (t) => {
  const dir = tempDir(t, "deckhand-image-walk-");
  mkdirSync(join(dir, "svc"));
  mkdirSync(join(dir, "lib"));
  const files = {
    "svc/server.mjs": [
      'import { a } from "../lib/a.mjs";',
      "export * from './b.mjs';",
      "// import('./commented.mjs') is only quoted",
      "const later = () => import('../lib/lazy.mjs');",
    ].join("\n"),
    "lib/a.mjs": [
      'import { readFileSync } from "node:fs";',
      'new Worker(new URL("./worker.mjs", import.meta.url));',
      "const read = (name) => readFileSync(new URL(`../prompts/${name}`, import.meta.url));",
      'readFileSync(new URL("../docs/config.md", import.meta.url));',
    ].join("\n"),
    "svc/b.mjs": "export const b = 1;\n",
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  assert.deepEqual(missing(dir, "svc/server.mjs").sort(), [
    'docs/config.md (lib/a.mjs: "../docs/config.md")',
    'lib/lazy.mjs (svc/server.mjs: "../lib/lazy.mjs")',
    'lib/worker.mjs (lib/a.mjs: "./worker.mjs")',
    'prompts (lib/a.mjs: "../prompts/")',
  ]);
});
