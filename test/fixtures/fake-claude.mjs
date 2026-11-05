// A fake `claude` for the machine driver's tests (machine/deckhand-machine.mjs), spawned through
// process.execPath: `--version` says one; otherwise its arguments and folder go to
// FAKE_CLAUDE_LOG (a JSON line), and it answers each stream-json message on its input as
// `claude -p --input-format stream-json --output-format stream-json` does: an assistant line and
// a result. A message's words steer it: `COMMIT` commits a file in its folder, `SLEEP <ms>`
// waits first, `FAIL` exits 3 at once, with a line on stderr. It ends when its input does.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
// Run as a test file of its own by `node --test` (its folder's files are): nothing to do.
if (!args.length) process.exit(0);
if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      env: !!process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    }) + "\n",
  );
}
const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
say({ type: "system", subtype: "init", session_id: at("--session-id") ?? at("--resume") });

let turns = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const text = JSON.parse(line).message.content;
  turns++;
  if (text.includes("FAIL")) {
    process.stderr.write("fake-claude: asked to fail\n");
    process.exit(3);
  }
  const sleep = /SLEEP (\d+)/.exec(text);
  if (sleep) await new Promise((r) => setTimeout(r, Number(sleep[1])));
  if (text.includes("COMMIT")) {
    writeFileSync(`turn-${turns}.txt`, `${text}\n`);
    execFileSync("git", ["add", "."]);
    execFileSync("git", ["commit", "--quiet", "-m", `Turn ${turns}`]);
  }
  say({ type: "assistant", message: { content: [{ type: "text", text: `On it: ${text}` }] } });
  say({ type: "result", is_error: false, result: `Done: ${text}`, duration_ms: 1000 });
}
