// /shots serves a run's screenshots, from a folder the sandbox writes: only its regular files,
// never what a link there points to.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { tempDir } from "./helpers.mjs";

const folder = "0123456789abcdef01234567";
let base, server;

before(async () => {
  const dataDir = tempDir(null, "deckhand-shots-");
  const shotsDir = join(dataDir, "shots");
  const dir = join(shotsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "app.json"), '{"privateKey":"secret"}');
  writeFileSync(join(dir, "page.png"), "PNG");
  symlinkSync(join(dataDir, "app.json"), join(dir, "absolute.png"));
  symlinkSync("../../app.json", join(dir, "relative.png"));
  symlinkSync("page.png", join(dir, "sibling.png"));
  symlinkSync(dataDir, join(dir, "dir.png"));
  linkSync(join(dataDir, "app.json"), join(dir, "hard.png"));
  execFileSync("mkfifo", [join(dir, "fifo.png")]);
  // The folder itself as a link: the run can't do that, but nothing should follow it either.
  symlinkSync(dir, join(shotsDir, "fedcba9876543210fedcba98"));

  const ctx = { config: { port: 0 }, log: () => {}, skip: () => {}, tasks: new Map(), shotsDir };
  server = createHttp(ctx, { dashboardDir: join(dataDir, "dist") }).listen();
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/shots`;
});

after(() => server.close());

test("serves a run's regular image files", async () => {
  const res = await fetch(`${base}/${folder}/page.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(await res.text(), "PNG");
});

test("a link in a run's folder is a 404, wherever it points", async () => {
  for (const name of ["absolute.png", "relative.png", "sibling.png", "dir.png", "hard.png"]) {
    const res = await fetch(`${base}/${folder}/${name}`);
    assert.equal(res.status, 404, name);
    assert.doesNotMatch(await res.text(), /secret/, name);
  }
  const res = await fetch(`${base}/fedcba9876543210fedcba98/page.png`);
  assert.equal(res.status, 404);
});

// A blocking open would wait for a writer, with the whole listener (a regression hangs here).
test("a FIFO in a run's folder is a 404, and doesn't block the listener", async () => {
  assert.equal((await fetch(`${base}/${folder}/fifo.png`)).status, 404);
});

test("missing files and other names are a 404", async () => {
  for (const path of [`${folder}/none.png`, `${folder}/page.txt`, "nothex/page.png"]) {
    assert.equal((await fetch(`${base}/${path}`)).status, 404, path);
  }
});
