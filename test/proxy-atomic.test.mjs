// Files the egress proxy keeps, written whole or not at all (proxy/atomic.mjs).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWrite, tempPath } from "../proxy/atomic.mjs";
import { assertMode, posix, tempDir } from "./helpers.mjs";

test("tempPath: a new tmp- name in the folder, with an optional suffix", () => {
  assert.match(posix(tempPath("/x")), /^\/x\/tmp-[0-9a-f]{16}$/);
  assert.match(posix(tempPath("/x", "ca.key")), /^\/x\/tmp-[0-9a-f]{16}-ca\.key$/);
  assert.notEqual(tempPath("/x"), tempPath("/x"));
});

test("atomicWrite: replaces the file, with its mode, and leaves no temporary one", async (t) => {
  const dir = tempDir(t, "deckhand-atomic-");
  const path = join(dir, "meta.json");
  await atomicWrite(path, "old");
  await atomicWrite(path, "new", { mode: 0o600 });
  assert.equal(readFileSync(path, "utf8"), "new");
  assertMode(path, 0o600);
  assert.deepEqual(readdirSync(dir), ["meta.json"]);
});

test("atomicWrite: a write that fails throws, and leaves no temporary file", async (t) => {
  const dir = tempDir(t, "deckhand-atomic-");
  const path = join(dir, "hosts", "a.pem");
  await atomicWrite(join(dir, "a.pem"), "x");
  // A missing target folder: the rename fails, the temporary file is removed, the error thrown.
  await assert.rejects(atomicWrite(path, "y", { dir, name: "host.pem" }), { code: "ENOENT" });
  assert.deepEqual(readdirSync(dir), ["a.pem"]);
});
