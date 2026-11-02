// Catching up with GitHub: the deliveries it couldn't hand over, asked for again
// (redeliveries.mjs scan()), and the open pull requests' states read again (pulls.mjs
// resync()). The listener does it at start, a user from the dashboard's Sync, which then asks
// the open pull requests of the repos that opted in whether they still merge (conflicts.mjs
// check()): the watcher's first tick does that at start. The last one's
// result is kept, in memory, for api/state: every browser sees when it ran and what it found,
// not just the one that pressed the button.

const message = (error) => String(error?.message ?? error);

// `scan()`: how many deliveries were asked again (null without an App); `resync()`: how many
// pull requests changed; `check()`: { started } rebase runs, and
// `errors`, the repos it couldn't check. `now`: injected by the tests.
export function createSync({
  scan,
  resync,
  check = async () => ({ started: 0, errors: [] }),
  log = () => {},
  now = Date.now,
}) {
  let last = null;

  // `by`: the user who asked, null for the listener at start. Resolves to the record: a part
  // that failed sets `error` and counts 0, the other's count is kept (it did its work). Never
  // throws.
  async function sync(by) {
    // A user's Sync reads every open pull request's CI again, not only those not settled.
    const [scanned, resynced] = await Promise.allSettled([scan(), resync({ allCi: by !== null })]);
    const errors = [];
    if (scanned.status === "rejected") {
      // At start, redeliveries.start()'s scan is the one shared here, and it logged it already.
      if (by !== null) log(`Sync: ${message(scanned.reason)}`);
      errors.push(message(scanned.reason));
    }
    if (resynced.status === "rejected") {
      log(`Sync: ${message(resynced.reason)}`);
      errors.push(message(resynced.reason));
    }
    // After resync(): a pull request merged or closed meanwhile isn't checked.
    let conflicts = 0;
    if (by !== null) {
      try {
        const checked = await check();
        conflicts = checked.started;
        // The repos it couldn't check (logged by conflicts.mjs): Sync didn't do all it says.
        if (checked.errors?.length) errors.push(...checked.errors);
      } catch (error) {
        log(`Sync: ${message(error)}`);
        errors.push(message(error));
      }
    }
    last = {
      at: now(),
      by,
      redelivered: scanned.value ?? 0,
      pulls: resynced.value ?? 0,
      conflicts,
      ...(errors.length && { error: errors.join("; ") }),
    };
    return last;
  }

  return { sync, last: () => last };
}
