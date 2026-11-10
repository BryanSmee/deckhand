// A run's requests for more permissions (#479): what its agent asks through the sandbox's
// deckhand-permissions (its MCP server, or its CLI), and the answer it waits for. The broker
// only carries them: a request goes on the `runs` stream (`permission`), where the orchestrator
// reads it, checks it against the run's ceiling and keeps it in its own store
// (../listener/requests.mjs); its answer comes back here (PUT /runs/:id/permissions/:request),
// where the sandbox's long poll reads it. Each request is its run's: the key holds the run's id,
// which the run token proves, so another run's token never reads it. Only the runs of
// PERMISSION_MODES may ask: the others' capabilities are decided at their start, with no profile
// to widen (#479's decision).
import { createHash, randomBytes } from "node:crypto";
import { Refused } from "../lib/http.mjs";
import { STREAM } from "./runs.mjs";

// The modes whose runs may ask: a chat's (machines', #600, ask through edge's /mcp instead).
export const PERMISSION_MODES = ["chat"];
export const KINDS = ["host", "github", "engine", "mount"];

// What a request may hold: its value, and its reason, which the orchestrator cuts further
// before anyone sees it.
const VALUE_MAX = 256;
export const REASON_MAX = 2000;
// How long one waits for its answer at most, past the orchestrator's own timeout
// (CHAT_PERMISSION_TIMEOUT, at most an hour): what ends one the orchestrator never answered.
const REQUEST_TTL_MS = 2 * 60 * 60_000;
// The sandbox's long poll for an answer, and how often the store is read meanwhile.
export const ANSWER_WAIT_MS = 25_000;
const POLL_EVERY_MS = 500;
// The most requests of a run kept at once: an agent asking in a loop fills no store.
export const REQUESTS_MAX = 50;
const STREAM_MAX = 10_000;

export const ID = /^[0-9a-f]{16}$/;
// What the sandbox names a request by, so that one sent again is the same one.
const KEY = /^[0-9a-f]{16,64}$/;
const STATES = ["granted", "denied", "refused"];
const MESSAGE_MAX = 2000;

const requestKey = (run, id) => `permission:${run}:${id}`;
const countKey = (run) => `permissions:${run}`;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

export function createPermissions({ store, now = Date.now, sleep = realSleep }) {
  // A request from run `record` (its run token checked): { kind, value, reason } → { status,
  // body }. Said on the stream for the orchestrator, then waited for.
  async function ask(record, body) {
    if (!PERMISSION_MODES.includes(record.mode)) {
      return refusal(403, "this run may not ask for permissions: only a chat's may");
    }
    const { kind, value = "", reason = "", key = null } = body ?? {};
    if (!KINDS.includes(kind)) return refusal(400, `kind: one of ${KINDS.join(", ")}`);
    if (typeof value !== "string" || value.length > VALUE_MAX) {
      return refusal(400, `value: text, ${VALUE_MAX} characters at most`);
    }
    if (typeof reason !== "string") return refusal(400, "reason: text");
    if (key !== null && !KEY.test(key)) return refusal(400, "key: 16 to 64 hex digits");
    // Sent again with its `key` (its first answer lost): the same request, never a second one,
    // said on the stream again only if its first POST may not have said it (`said` unset).
    const id = key
      ? createHash("sha256").update(`${record.id}:${key}`).digest("hex").slice(0, 16)
      : randomBytes(8).toString("hex");
    const created = await store.setIfAbsent(
      requestKey(record.id, id),
      { state: "pending" },
      { ttlMs: REQUEST_TTL_MS },
    );
    if (created) {
      // No expiry: it lasts as long as the run, which deletes it as it ends (forget()).
      const asked = await store.increment(countKey(record.id), 1);
      if (asked > REQUESTS_MAX) {
        await store.delete(requestKey(record.id, id));
        return refusal(429, `this run asked ${REQUESTS_MAX} times already: no more requests`);
      }
    } else {
      const found = await store.get(requestKey(record.id, id));
      // Answered already: its answer is there to read.
      if (found?.state !== "pending") return { status: 202, body: { id, state: "answered" } };
      // Said already: a sandbox sending it in a loop adds nothing to the stream every run shares.
      if (found.said) return { status: 202, body: { id, state: "pending" } };
    }
    await store.append(
      STREAM,
      {
        type: "permission",
        run: record.id,
        at: now(),
        id,
        kind,
        value,
        reason: reason.slice(0, REASON_MAX),
      },
      { maxLength: STREAM_MAX },
    );
    // Marked said, unless it was answered meanwhile (that answer stays).
    await store.compareAndSet(
      requestKey(record.id, id),
      { state: "pending" },
      { state: "pending", said: true },
      { ttlMs: REQUEST_TTL_MS },
    );
    return { status: 202, body: { id, state: "pending" } };
  }

  // Its answer, waiting up to ANSWER_WAIT_MS for one: { state, message } once answered, null
  // while it waits, undefined for none of this run's.
  async function answerOf(run, id, { signal, timeout = ANSWER_WAIT_MS } = {}) {
    if (!ID.test(id)) return undefined;
    const until = now() + timeout;
    for (;;) {
      const found = await store.get(requestKey(run, id));
      if (!found) return undefined;
      if (found.state !== "pending") return found;
      if (signal?.aborted || now() >= until) return null;
      await sleep(Math.min(POLL_EVERY_MS, until - now()));
    }
  }

  // The orchestrator's answer to a request: { state, message }. One answered already keeps its
  // first answer (the same one again is fine). → whether the request is there.
  async function answer(run, id, body) {
    if (!ID.test(id)) return false;
    const state = STATES.includes(body?.state) ? body.state : null;
    if (!state) throw new Refused(400, `state: one of ${STATES.join(", ")}`);
    const message = typeof body?.message === "string" ? body.message.slice(0, MESSAGE_MAX) : "";
    for (;;) {
      const before = await store.get(requestKey(run, id));
      if (!before) return false;
      if (before.state !== "pending") return true;
      const after = { state, message };
      const ok = await store.compareAndSet(requestKey(run, id), before, after, {
        ttlMs: REQUEST_TTL_MS,
      });
      if (ok) return true;
    }
  }

  // A run ended (DELETE /runs/:id), or its record expired: its count goes with it.
  const forget = (run) => store.delete(countKey(run));

  return { ask, answerOf, answer, forget };
}

const refusal = (status, message) => ({ status, body: { message } });
