// The fake docker's own contract (fixtures/fake-docker.sh), where the orchestrator tests lean on
// it: `docker logs --follow` gives all of a sandbox's output, its last line too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { needsBash, scriptEnv, tempDir, until } from "./helpers.mjs";

// A temp dir with the fake docker, a sandbox `name` whose writer the test holds (a process it
// kills), and a `tail` that stops as uutils' does (#1122): what was there when it started, then
// nothing more, once the process is gone. A fake that followed with `tail --pid` would lose the
// line written last.
function sandbox(t) {
  const dir = tempDir(t);
  symlinkSync(join(import.meta.dirname, "fixtures", "fake-docker.sh"), join(dir, "docker"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tail"),
    `#!/bin/bash
for a in "$@"; do case "$a" in --pid=*) pid=\${a#--pid=} ;; esac; file=$a; done
cat "$file"
while kill -0 "$pid" 2> /dev/null; do read -r -t 0.05 < <(sleep 1) || :; done
`,
  );
  chmodSync(join(bin, "tail"), 0o755);
  const box = join(dir, "containers", "box");
  mkdirSync(box, { recursive: true });
  const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"]);
  t.after(() => writer.kill("SIGKILL"));
  writeFileSync(join(box, "pid"), `${writer.pid}\n`);
  writeFileSync(join(box, "out"), "");
  return {
    dir,
    writer,
    out: join(box, "out"),
    env: scriptEnv(t, { PATH: `${bin}:${process.env.PATH}` }),
  };
}

function logs({ dir, env }, ...flags) {
  const child = spawn(join(dir, "docker"), ["logs", "--follow", ...flags, "box"], { env });
  let out = "";
  child.stdout.on("data", (data) => (out += data));
  const closed = new Promise((resolve) => child.on("close", resolve));
  return { read: () => out, closed };
}

for (const flags of [[], ["--timestamps"]]) {
  test(
    `docker logs --follow${flags.map((f) => ` ${f}`).join("")}: the line a sandbox wrote as it exited is read`,
    { skip: needsBash },
    async (t) => {
      const box = sandbox(t);
      appendFileSync(box.out, "first\n");
      const followed = logs(box, ...flags);
      await until(() => followed.read().includes("first"), { what: "its first line" });
      // Written and gone at once, while the follow waits for more.
      appendFileSync(box.out, "last\nno newline");
      box.writer.kill("SIGKILL");
      assert.equal(await followed.closed, 0);
      const lines = followed.read().replace(/^\S+Z /gm, "");
      assert.equal(lines, "first\nlast\nno newline\n");
    },
  );
}

test(
  "docker logs --follow fails when its sandbox's pid can't be read",
  { skip: needsBash },
  async (t) => {
    const box = sandbox(t);
    writeFileSync(join(box.dir, "containers", "box", "pid"), "");
    const followed = logs(box, "--timestamps");
    assert.notEqual(await followed.closed, 0);
  },
);
