// Catching up with GitHub: the deliveries it couldn't hand over, asked for again
// (redeliveries.mjs scan()), and the open pull requests' states read again (pulls.mjs
// resync()). The listener does it at start, a user from the dashboard's Sync. The last one's
// result is kept, in memory, for api/state: every browser sees when it ran and what it found,
// not just the one that pressed the button.

// `scan()`: how many deliveries were asked again (null without an App); `resync()`: how many
// pull requests changed. `now`: injected by the tests.
export function createSync({ scan, resync, log = () => {}, now = Date.now }) {
  let last = null;

  // `by`: the user who asked, null for the listener at start. Resolves to the record, its
  // `error` set when it failed: it never throws.
  async function sync(by) {
    let record;
    try {
      const [redelivered, pulls] = await Promise.all([scan(), resync()]);
      record = { at: now(), by, redelivered: redelivered ?? 0, pulls: pulls ?? 0 };
    } catch (error) {
      log(`Sync: ${error.message ?? error}`);
      record = { at: now(), by, redelivered: 0, pulls: 0, error: String(error.message ?? error) };
    }
    last = record;
    return record;
  }

  return { sync, last: () => last };
}
