// Run events (#503): a sandbox started, a sandbox ended (and its exit code), in a stream of the
// runner's store that the orchestrator reads and acknowledges once handled (store.mjs read(),
// ack()), so none is lost while either service hands over to its other copy. The copy holding
// the runner's lease watches the sandboxes (watch()); which ones it saw running is in the store
// too, so the next copy says each end once.

export const STREAM = "run-events";
const CONSUMER = "orchestrator";
const RUNNING = "events/running";
// Enough for a long pause of the orchestrator; its events are a few a run.
const MAX_LENGTH = 10_000;

export function createEvents({ store, runner, log = () => {}, now = Date.now }) {
  const append = (event) =>
    store.append(STREAM, { ...event, at: now() }, { maxLength: MAX_LENGTH });

  // One change of the sandboxes seen running at a time, in order: a start said while a look
  // reads them would be lost, or taken for an end.
  let chain = Promise.resolve();
  const inTurn = (fn) => {
    const done = chain.then(fn);
    chain = done.catch(() => {});
    return done;
  };

  const started = (run, name) =>
    inTurn(async () => {
      await append({ type: "started", run, name });
      const running = (await store.get(RUNNING)) ?? {};
      await store.set(RUNNING, { ...running, [run]: name });
    });

  // A sandbox about to be removed (its run is over): its end said now, while Docker still has
  // its exit code, rather than by a look after it's gone.
  const ending = (run, name) =>
    inTurn(async () => {
      const running = (await store.get(RUNNING)) ?? {};
      if (!(run in running)) return;
      const exitCode = (await runner.exitCode?.(name).catch(() => null)) ?? null;
      await append({ type: "ended", run, name, exitCode });
      const { [run]: _, ...still } = running;
      await store.set(RUNNING, still);
    });

  // The sandboxes that stopped running since the last look: their end, with their exit code
  // when the backend tells it. A look while one is under way is that one.
  let looking = null;
  function watch() {
    looking ??= inTurn(look).finally(() => (looking = null));
    return looking;
  }

  async function look() {
    // What was seen running before the list: a sandbox started since is in the list.
    const running = (await store.get(RUNNING)) ?? {};
    const listed = await runner.list();
    const up = new Set(listed.filter((s) => s.running).map((s) => s.run));
    const still = {};
    for (const [run, name] of Object.entries(running)) {
      if (up.has(run)) {
        still[run] = name;
        continue;
      }
      const exitCode = (await runner.exitCode?.(name).catch(() => null)) ?? null;
      await append({ type: "ended", run, name, exitCode });
      log(`${name}: its sandbox ended${exitCode === null ? "" : ` (exit ${exitCode})`}`);
    }
    // Ones started by a copy from before events, or whose start's write was lost.
    for (const s of listed) if (s.running && !(s.run in still)) still[s.run] = s.name;
    // Written when it changed only: a look every few seconds.
    if (JSON.stringify(still) !== JSON.stringify(running)) await store.set(RUNNING, still);
  }

  return {
    started,
    ending,
    watch,
    read: () => store.read(STREAM, CONSUMER),
    ack: (ids) => store.ack(STREAM, CONSUMER, ids),
  };
}
