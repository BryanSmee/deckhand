// The runner's run events (#503, ../runner/events.mjs): a sandbox started, a sandbox ended and
// its exit code, read from its stream and acknowledged once handled, so none is lost while the
// runner or the listener restarts. A run's end itself is still seen as its output ends
// (runs.mjs follow()): an event says how the sandbox ended, which its output doesn't (killed for
// its memory, 137).
import { writeEvent } from "./runlog.mjs";

export function createRunEvents({
  events, // ../runner/client.mjs's: read(), ack(ids)
  // run id → { record, logFile, save() }: the run, live or over (its end is said as its
  // sandbox is removed, by then its summary may be written: save() writes it again), or null
  runOf,
  log = () => {},
  everyMs = 5000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;

  function handle({ event }) {
    if (event?.type !== "ended") return;
    const run = runOf(event.run);
    if (!run || run.record.exitCode != null) return;
    run.record.exitCode = event.exitCode;
    if (event.exitCode) {
      const message = `Its sandbox exited with code ${event.exitCode}`;
      log(`${run.record.key}: ${message}`);
      writeEvent(run.logFile, "note", { message });
      // Said after the run's end, which closed its log's last segment (runs.mjs teardown()):
      // the segment this note opened closes after it (../runner/logs.mjs).
      if (run.record.finishedAt) run.logFile.close?.();
    }
    run.save();
  }

  async function poll() {
    timer = null;
    try {
      const found = await events.read();
      for (const entry of found) {
        try {
          handle(entry);
        } catch (error) {
          log(`Run events: ${error.stack ?? error}`);
        }
      }
      if (found.length) await events.ack(found.map((e) => e.id));
    } catch (error) {
      log(`Run events: ${error.message ?? error}`);
    }
    if (!stopped) {
      timer = setTimer(poll, everyMs);
      timer.unref?.();
    }
  }

  return {
    start: () => poll(),
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
    poll,
  };
}
