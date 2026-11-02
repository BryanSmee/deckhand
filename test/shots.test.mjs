// /shots serves a run's screenshots, from a folder the sandbox writes: only its regular files,
// never what a link there points to.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { needsBash, needsSymlinks, tempDir } from "./helpers.mjs";

const folder = "0123456789abcdef01234567";
let base, server;
const logged = [];

before(async () => {
  const dataDir = tempDir(null, "deckhand-shots-");
  const shotsDir = join(dataDir, "shots");
  const dir = join(shotsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "app.json"), '{"privateKey":"secret"}');
  writeFileSync(join(dir, "page.png"), "PNG");
  // Not on Windows (their tests skip there): links need its developer mode, and it has no FIFO.
  if (!needsSymlinks) {
    symlinkSync(join(dataDir, "app.json"), join(dir, "absolute.png"));
    symlinkSync("../../app.json", join(dir, "relative.png"));
    symlinkSync("page.png", join(dir, "sibling.png"));
    symlinkSync(dataDir, join(dir, "dir.png"));
    linkSync(join(dataDir, "app.json"), join(dir, "hard.png"));
    // The folder itself as a link: the run can't do that, but nothing should follow it either.
    symlinkSync(dir, join(shotsDir, "fedcba9876543210fedcba98"));
  }
  if (!needsBash) execFileSync("mkfifo", [join(dir, "fifo.png")]);

  const ctx = {
    config: { port: 0 },
    log: (line) => logged.push(line),
    skip: () => {},
    tasks: new Map(),
    shotsDir,
  };
  // As edge passes them on (../edge/forward.mjs): /shots/ is public, /status a local caller's.
  const http = createHttp(ctx);
  server = createServer((req, res) => http.handle(req, res, { local: true }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/shots`;
});

after(() => server.close());

test("serves a run's regular image files", async () => {
  const res = await fetch(`${base}/${folder}/page.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(await res.text(), "PNG");
});

test("a link in a run's folder is a 404, wherever it points", { skip: needsSymlinks }, async () => {
  for (const name of ["absolute.png", "relative.png", "sibling.png", "dir.png", "hard.png"]) {
    const res = await fetch(`${base}/${folder}/${name}`);
    assert.equal(res.status, 404, name);
    assert.doesNotMatch(await res.text(), /secret/, name);
  }
  const res = await fetch(`${base}/fedcba9876543210fedcba98/page.png`);
  assert.equal(res.status, 404);
});

// A blocking open would wait for a writer, with the whole orchestrator (a regression hangs here).
test(
  "a FIFO in a run's folder is a 404, and doesn't block the orchestrator",
  { skip: needsBash },
  async () => {
    assert.equal((await fetch(`${base}/${folder}/fifo.png`)).status, 404);
  },
);

test("missing files and other names are a 404", async () => {
  for (const path of [`${folder}/none.png`, `${folder}/page.txt`, "nothex/page.png"]) {
    assert.equal((await fetch(`${base}/${path}`)).status, 404, path);
  }
});

// A route that throws (here: this orchestrator has no status) answers 500 and leaves the
// orchestrator up, its error logged.
test("an unexpected throw answers 500, and the orchestrator keeps serving", async () => {
  const res = await fetch(base.replace(/\/shots$/, "/status"));
  assert.equal(res.status, 500);
  assert.ok(logged.some((line) => line.startsWith("GET /status: TypeError")));
  assert.equal((await fetch(`${base}/${folder}/page.png`)).status, 200);
});
