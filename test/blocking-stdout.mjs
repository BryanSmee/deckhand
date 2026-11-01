// Preloaded in each test file's process (`node --test --import ./test/blocking-stdout.mjs`,
// AGENTS.md): its results go to `node --test` on its stdout, a pipe. Written at once while the
// pipe has room, they are queued once it is full (`node --test` busy reading many files, on a
// loaded runner), and --test-force-exit ends the process without waiting for that queue: the
// file's last tests never reported, the run passing without them (#563). Blocking writes wait
// for the room instead. `node --test` also runs this file as one of its own: it has no tests.
process.stdout._handle?.setBlocking?.(true);
