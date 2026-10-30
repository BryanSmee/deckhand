// The shared helpers' guarantees the suite relies on (helpers.mjs).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers.mjs";

// #521: a test whose cleanup fails skips the hooks after it, its server's close among them. The
// server mustn't keep the file's process alive then: `node --test` would wait for it forever.
// The file runs in a process of its own, outside test/ (`node --test` runs every file there).
test("a cleanup that fails: reported, and the file's process still exits", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "cleanup.test.mjs");
  writeFileSync(
    file,
    `import { test } from "node:test";
import { serve } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};
test("a cleanup that fails", async (t) => {
  t.after(() => {
    throw new Error("the cleanup failed");
  });
  await serve(t, (req, res) => res.end());
});
`,
  );
  // Without --test-force-exit: the helper alone has to let it end. Not as a child of this
  // runner (NODE_TEST_CONTEXT), which would report to it rather than run the file itself. TAP,
  // whatever Node's default (Node 26 reports `spec` to a pipe too).
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const args = ["--test", "--test-reporter=tap", file];
  const ran = await new Promise((resolve) =>
    execFile(process.execPath, args, { env, timeout: 20_000 }, (error, stdout) =>
      resolve({ killed: !!error?.killed, code: error?.code ?? 0, stdout }),
    ),
  );
  assert.equal(ran.killed, false, "the file's process didn't exit");
  assert.equal(ran.code, 1);
  assert.match(ran.stdout, /the cleanup failed/);
  assert.match(ran.stdout, /# fail 1/);
});
