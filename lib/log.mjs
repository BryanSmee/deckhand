// The services' own log lines (#547): one per call, on stdout, as JSON (LOG_FORMAT=json, the
// default: what a cluster's collector reads) or as text (LOG_FORMAT=text, which compose.yaml
// sets: `docker compose logs`). Every line carries its time, level, service and message, and the
// request, repository, issue and run it belongs to when there is one (the context below), and
// goes through redact.mjs first: once logs leave the host, a leaked token is hard to get back.
// The runs' own output never comes here (the runner keeps it).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { format } from "node:util";
import { redact } from "./redact.mjs";

// The header a request's ID travels in from one service to the next (service-client.mjs,
// broker-client.mjs, the policy client): one grep follows a webhook across them.
export const REQUEST_HEADER = "x-deckhand-request";

export const LEVELS = ["debug", "info", "warn", "error"];
const FORMATS = ["json", "text"];

// The context fields, in the order a text line shows them.
const CONTEXT = ["request", "repo", "issue", "run"];

// What a call made while handling a request (or a run) logs it with, through awaits and
// timers alike.
const context = new AsyncLocalStorage();

// `fn()` with `fields` added to the context (those set already kept, unless `fields` sets them
// again; undefined and null leave them as they are).
export function withLogContext(fields, fn) {
  const added = Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v != null));
  return context.run({ ...context.getStore(), ...added }, fn);
}

// `fn()` with `fields` alone as its context, whatever it was started in: work for another
// repository or issue than its caller's (a run another run's end starts, a sweep) never logs
// under the caller's.
export function newLogContext(fields, fn) {
  const own = Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v != null));
  return context.run(own, fn);
}

// The context's fields now: {} outside any.
export const logContext = () => ({ ...context.getStore() });

// A new request's ID: short, as it shows on every line.
export const newRequestId = () => randomBytes(8).toString("hex");

// A request ID another service sent, if it looks like one: anything else (too long, other
// characters) is no ID of ours, and a new one is made.
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const validRequestId = (value) =>
  typeof value === "string" && REQUEST_ID.test(value) ? value : null;

// The header to send on a call to another service: the request being handled, if any.
export function requestHeaders() {
  const request = context.getStore()?.request;
  return request ? { [REQUEST_HEADER]: request } : {};
}

// An http server's handler, run in a request's context: the ID its caller sent (another
// service's), else a new one. `trusted: false` (edge's public port, which the internet reaches)
// always makes a new one.
export function withRequest(handler, { trusted = true } = {}) {
  return (req, res) => {
    const sent = trusted ? validRequestId(req.headers[REQUEST_HEADER]) : null;
    return withLogContext({ request: sent ?? newRequestId() }, () => handler(req, res));
  };
}

// How deep a field's value is walked: anything deeper is left out rather than written
// unredacted (a cycle ends there too).
const MAX_DEPTH = 8;
export const TOO_DEEP = "[too deep]";

// A field's value as a line shows it, at any depth: an Error by its stack, a Date or URL as
// JSON writes it (toJSON()), a Map or Set as a list, a bigint as text.
function plain(value) {
  if (value instanceof Error) return value.stack ?? String(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Map) return [...value];
  if (value instanceof Set) return [...value];
  if (value !== null && typeof value === "object" && typeof value.toJSON === "function") {
    return value.toJSON();
  }
  return value;
}

// `value` with every string in it redacted (keys too: a token pasted as one).
function redacted(value, secrets, depth = 0) {
  value = plain(value);
  if (typeof value === "string") return redact(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((v) => redacted(v, secrets, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [redact(k, secrets), redacted(v, secrets, depth + 1)]),
  );
}

// A text line's `key=value`: quoted when it holds a space, a quote or a newline.
function pair(key, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `${key}=${/[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text}`;
}

// A module whose `log` may be a test's plain function writes an error line with
// `(log.error ?? log)(…)`.
// → log(...args), as console.log takes them (the injected `log` every module calls), at info;
// log.debug / info / warn / error(msg, fields). `service`: its name on every line; `secrets()`:
// what the service holds that is redacted besides GitHub's and the run tokens' shapes (its
// key, a session key…), a list as redact() takes it. LOG_LEVEL (info) and LOG_FORMAT (json)
// from `env`; a value not known is said once, and the default used.
export function createLogger({
  service,
  env = process.env,
  secrets = () => [],
  // Through console.log, which drops a write its reader is gone for (EPIPE): a bare
  // process.stdout.write would throw it as an unhandled 'error', the service down over a line.
  write = (line) => console.log(line),
  now = () => new Date(),
} = {}) {
  const problems = [];
  const levelName = (env.LOG_LEVEL || "info").toLowerCase();
  if (!LEVELS.includes(levelName)) problems.push(`LOG_LEVEL: ${levelName} unknown, info used`);
  const least = LEVELS.includes(levelName) ? LEVELS.indexOf(levelName) : LEVELS.indexOf("info");
  const formatName = (env.LOG_FORMAT || "json").toLowerCase();
  if (!FORMATS.includes(formatName)) problems.push(`LOG_FORMAT: ${formatName} unknown, json used`);
  const text = formatName === "text";

  function line(level, msg, fields = {}) {
    if (LEVELS.indexOf(level) < least) return;
    let held = [];
    try {
      held = secrets() ?? [];
    } catch {
      // A service's secrets not readable yet: the token shapes are still redacted.
    }
    const own = { ...context.getStore(), ...fields };
    const ts = now().toISOString();
    const message = redact(typeof msg === "string" ? msg : format(msg), held);
    const extra = redacted(own, held);
    if (text) {
      const known = CONTEXT.filter((k) => extra[k] != null).map((k) => pair(k, extra[k]));
      const rest = Object.entries(extra)
        .filter(([k, v]) => !CONTEXT.includes(k) && v !== undefined)
        .map(([k, v]) => pair(k, v));
      const head = level === "info" ? ts : `${ts} ${level.toUpperCase()}`;
      return write([head, message, ...known, ...rest].join(" "));
    }
    // The line's own keys can't be overwritten by a field of the same name.
    const out = { ts, level, service, msg: message };
    for (const [k, v] of Object.entries(extra)) if (!(k in out)) out[k] = v;
    write(JSON.stringify(out));
  }

  const log = (...args) => line("info", format(...args));
  for (const level of LEVELS) log[level] = (msg, fields) => line(level, msg, fields);
  for (const problem of problems) log.warn(problem);
  return log;
}

// A delivery's context (edge's stream entry, ../edge/http.mjs): the request ID edge gave it
// (a new one for an entry from before #547), its repository and issue, pull request or
// discussion number.
export function deliveryContext(entry) {
  const payload = entry?.payload;
  const item = payload?.issue ?? payload?.pull_request ?? payload?.discussion;
  return {
    request: validRequestId(entry?.request) ?? newRequestId(),
    repo: typeof payload?.repository?.full_name === "string" ? payload.repository.full_name : null,
    issue: Number.isInteger(item?.number) ? item.number : null,
  };
}
