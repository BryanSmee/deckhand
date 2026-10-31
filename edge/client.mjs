// Edge (#506) as the orchestrator calls it, on edge's internal port (internal.mjs): the verified
// deliveries' stream, read and acknowledged once handled; the App's public parts; the dashboard's
// "from" tags; the redeliveries' scan; a listener's App handed over. Every call carries the
// orchestrator's service token.
import { serviceClient, WAIT_MS } from "../lib/service-client.mjs";

const RETRY_MS = 2_000;
// Under edge's limit for one ask (internal.mjs MAX_TAGS).
const TAGS_AT_ONCE = 500;

// `urls`: EDGE_URL (comma-separated: its copies); `token()`: the orchestrator's Authorization
// header for edge.
export function createEdgeClient({
  urls,
  token,
  fetch = globalThis.fetch,
  waitMs = WAIT_MS,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
}) {
  const client = serviceClient({ service: "edge", urls, token, fetch, waitMs, log });
  let stopped = false;
  // Ends the long poll under way at stop().
  const stopping = new AbortController();

  // The `deliveries` stream, read under the orchestrator's one consumer name while `active()`:
  // `handle(entry)` resolves once it is handled, then it is acknowledged. One that fails is read
  // again, a little later. Resolves once stop() is called.
  let consuming = null;
  function consume(handle, { active = () => true } = {}) {
    consuming ??= (async () => {
      while (!stopped) {
        if (!active()) {
          await sleep(250);
          continue;
        }
        try {
          // Not waited for long when edge is away: asked again in the loop, so stop() ends it.
          const { events } = await client.json("GET", "/events?wait=20000", {
            waitMs: 10_000,
            signal: stopping.signal,
          });
          const done = [];
          for (const { id, event } of events) {
            if (stopped || !active()) break;
            try {
              await handle(event);
              done.push(id);
            } catch (error) {
              log(`Edge: delivery ${event?.id ?? id} (${error.message}), read again`);
              break;
            }
          }
          if (done.length) await client.json("POST", "/events/ack", { body: { ids: done } });
          if (done.length < events.length) await sleep(RETRY_MS);
        } catch (error) {
          if (stopped) break;
          log(`Edge: its deliveries (${error.message}), asking again`);
          await sleep(RETRY_MS);
        }
      }
    })();
    return consuming;
  }

  return {
    consume,
    // { configured, id, slug, owner, html_url, bot_id, public_url }.
    app: (options) => client.json("GET", "/app", options),
    // [{ user, text }] → their tags, or nulls without an App.
    async tags(items) {
      const tags = [];
      for (let i = 0; i < items.length; i += TAGS_AT_ONCE) {
        const body = { items: items.slice(i, i + TAGS_AT_ONCE) };
        tags.push(...(await client.json("POST", "/from-tags", { body })).tags);
      }
      return tags;
    },
    scan: async () => (await client.json("POST", "/redeliveries/scan", { waitMs: 30_000 })).count,
    handOver: (body) => client.json("PUT", "/app", { body }),
    stop() {
      stopped = true;
      stopping.abort();
      return consuming ?? Promise.resolve();
    },
  };
}
