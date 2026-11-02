// Preloaded in each test file's process (`node --test --import ./test/blocking-stdout.mjs`,
// AGENTS.md): its results go to `node --test` on its stdout, a pipe. Written at once while the
// pipe has room, they are queued once it is full (`node --test` busy reading many files, on a
// loaded runner), and --test-force-exit ends the process without waiting for that queue: the
// file's last tests never reported, the run passing without them (#563). Blocking writes wait
// for the room instead. `node --test` also runs this file as one of its own: it has no tests.
import { fstatSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

// Node's own handle, not a public API: should a Node update take it away, every test file
// fails here, rather than the runs going back to losing results without a word. Not in a
// worker thread a test starts (preloaded there too): its stdout is the worker's, the results
// aren't written there.
if (isMainThread) {
  const handle = process.stdout._handle;
  if (typeof handle?.setBlocking === "function") handle.setBlocking(true);
  // `node --test` gives its files a socket pair; a shell, a FIFO.
  else if (fstatSync(1).isFIFO() || fstatSync(1).isSocket()) {
    throw new Error("test/blocking-stdout.mjs: stdout is a pipe this Node can't make blocking");
  }
}
