// Files the egress proxy keeps, written whole or not at all (proxy/atomic.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWrite, tempPath } from "../proxy/atomic.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("tempPath: a new tmp- name in the folder, with an optional suffix", () => {
  assert.match(tempPath("/x"), /^\/x\/tmp-[0-9a-f]{16}$/);
  assert.match(tempPath("/x", "ca.key"), /^\/x\/tmp-[0-9a-f]{16}-ca\.key$/);
  assert.notEqual(tempPath("/x"), tempPath("/x"));
});

test("atomicWrite: replaces the file, with its mode, and leaves no temporary one", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "meta.json");
  await atomicWrite(path, "old");
  await atomicWrite(path, "new", { mode: 0o600 });
  assert.equal(readFileSync(path, "utf8"), "new");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["meta.json"]);
});

test("atomicWrite: a write that fails throws, and leaves no temporary file", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "hosts", "a.pem");
  await atomicWrite(join(dir, "a.pem"), "x");
  // A missing target folder: the rename fails, the temporary file is removed, the error thrown.
  await assert.rejects(atomicWrite(path, "y", { dir, name: "host.pem" }), { code: "ENOENT" });
  assert.deepEqual(readdirSync(dir), ["a.pem"]);
});
