// Requests for more permissions (#479): a run's agent that hits a wall (a host the egress proxy
// refuses, the container engine it lacks…) asks through its sandbox's deckhand-permissions, an
// MCP server and a CLI (../sandbox/deckhand-permissions), which call the broker; the broker
// says it on its `runs` stream (../broker/permissions.mjs), and here the orchestrator decides:
//
// - beyond the run's ceiling (what the policies, the repo's config and the operator's grants
//   give it), refused at once, the reason given to the agent: only the operator widens that, in
//   the grants folder (#479's decision); nobody is asked;
// - what the sandbox has already, granted at once; what its owner's saved choices give it
//   already (a profile changed since it started), granted without asking either;
// - the rest waits for the run's owner, shown in the dashboard as a card (Approve once, Approve
//   for this chat, Deny), until CHAT_PERMISSION_TIMEOUT, which denies it.
//
// The answer goes back to the broker, where the agent's tool call reads it. A host approved
// applies at once (the proxy reads the run's hosts on each connection), the rest at the
// sandbox's next start, which the answer tells the agent. What the requests are about, and how
// an approval applies, is their subject's: a chat's (chats.mjs decideRequest(), grantRequest()).
// Not chat-only: the store, the answers and the timeout are any owned run's. A machine's run
// (#600) asks too, from edge's /mcp: its agent's (Claude Code's `--permission-prompt-tool`) tool
// calls, through its driver's approve_permission (claims.mjs approve()). Deckhand has no ceiling
// for those (the machine's is its own): each one waits for the run's owner, shown on the
// dashboard and in a comment on the issue (askTool()), answered with Allow once, Allow for this
// run (that tool's calls in the run, from then on) or Deny, on the dashboard or with `/allow` or
// `/deny` on the issue (fromComment()), from the owner alone; the same timeout denies it. Its
// driver reads the answer (settled()), no broker between them.
//
// Kept in the orchestrator's store (REQUESTS_KEY), which its two copies share: the next copy
// takes them up (load()), their timeouts and the answers the broker hasn't heard.
import { randomBytes } from "node:crypto";

import { SHORT_ID } from "./events.mjs";
import { writeEvent } from "./runlog.mjs";
import { redact, operatorSecrets } from "./secrets.mjs";
import { taskId } from "./spelling.mjs";

export const REQUESTS_KEY = "permission-requests";

// What the dashboard shows of a reason the agent wrote: one line, cut to this (as the policies'
// messages are: ../docs/security/policies.md#policies), redacted, and shown as text, never markup.
export const REASON_MAX = 200;
// How many of a run's requests may wait for its owner at once: an agent asking in parallel
// gets the rest refused, to ask again once they are answered.
export const WAITING_MAX = 3;
// How long an answered request is kept, so that the broker's stream read again (a copy that
// stopped before acknowledging it) doesn't ask twice.
const KEPT_MS = 24 * 60 * 60_000;
// How soon an answer the broker didn't take is sent again.
const RETRY_MS = 5_000;

// How an owner answers: approved for the sandbox going (and the next start, for what applies
// only then), approved for the chat (saved in its profile), or denied.
export const ANSWERS = ["once", "chat", "deny"];

// And a machine run's owner (#600): this call alone, the tool's calls for the rest of the run,
// or denied.
const TOOL_ANSWERS = ["once", "run", "deny"];

const ID = /^[0-9a-f]{16}$/;
// A tool's name at most: Claude Code's are short, an MCP server's `mcp__<server>__<tool>` longer.
const TOOL_MAX = 100;
// The input field that says the most of a tool call alone, for those that have one (Claude
// Code's Bash, Read, Write, Edit, WebFetch, Grep…): shown rather than the whole input's JSON.
const LEADS = ["command", "file_path", "notebook_path", "path", "url", "pattern"];

const lower = (s) => String(s ?? "").toLowerCase();

// A reason as the dashboard shows it: one line, redacted, cut.
export function reasonLine(text, secrets = []) {
  const one = redact(String(text ?? ""), secrets)
    .replace(/\s+/g, " ")
    .trim();
  return one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1)}…` : one;
}

// What the owner reads of a tool call's input: its lead field, or its JSON, as a reason is
// (reasonLine()).
export function inputLine(input, secrets = []) {
  const lead =
    input && typeof input === "object" ? LEADS.find((k) => typeof input[k] === "string") : null;
  return reasonLine(lead ? input[lead] : JSON.stringify(input ?? null), secrets);
}

// `text` in a fenced block GitHub shows as it is: no markdown, no HTML, no mention. The fence is
// longer than any run of backticks in it, so none ends it.
export function fenced(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time:
// `ctx.chats` decides and applies a chat's requests, `ctx.brokerService` takes the answers;
// `ctx.reply` posts a machine run's on its issue, `ctx.settle` reacts to an answer's comment.
export function createRequests(
  ctx,
  {
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    retryMs = RETRY_MS,
    newId = () => randomBytes(8).toString("hex"),
  } = {},
) {
  const { config, log } = ctx;
  // id → { id, run, key, chat, owner, kind, value, reason, what, adds, live, state, scope,
  // message, at, expiresAt, answeredAt, by, told }. `state`: pending, granted, denied or
  // refused; `told`: whether the broker has its answer. A machine run's (#600) has `machine`
  // (its name) and `toolUseId`, its `kind` "tool", `what` the tool, `reason` its input's line;
  // nothing to tell the broker.
  const requests = new Map();
  const timers = new Map();
  // A machine run's requests' calls waiting for their answer (settled()): id → their wake-ups.
  const waiters = new Map();
  // The requests being decided (received()) or answered (answer()): a second answer is refused
  // meanwhile, and their timeout waits for the answer under way.
  const busy = new Set();
  let stopped = false;

  async function load() {
    const saved = (await ctx.store.get(REQUESTS_KEY)) ?? {};
    requests.clear();
    for (const [id, r] of Object.entries(saved)) if (ID.test(id)) requests.set(id, r);
  }

  let saving = Promise.resolve();
  // One write after the other, the latest state when each begins. A failure is logged, and the
  // next write has it; `strict`: it rejects too, for a caller that must know (stored()).
  function save({ strict = false } = {}) {
    const kept = now() - KEPT_MS;
    for (const [id, r] of requests) {
      if (r.state !== "pending" && r.told && r.answeredAt < kept) requests.delete(id);
    }
    const done = saving.then(() => ctx.store.set(REQUESTS_KEY, Object.fromEntries(requests)));
    saving = done.catch((error) => log(`Saving the permission requests: ${error.stack ?? error}`));
    return strict ? done : saving;
  }

  // The task whose run is `run` (its id, the tokens' `jti`), or null once it ended.
  const taskOfRun = (run) =>
    [...ctx.tasks.values()].find((t) => t.live?.id === run && !t.live.finishing) ?? null;
  // In the run's log: a sandbox's through the broker, a machine's (no sandbox) here.
  const note = (run, message) => {
    const sandbox = ctx.broker?.runOf(run);
    if (sandbox) return sandbox.note?.(message);
    const live = taskOfRun(run)?.live;
    if (live?.external && live.logFile) writeEvent(live.logFile, "note", { message });
  };
  const endedText = (record) =>
    record.machine ? "Denied: this run has ended." : "Denied: this sandbox's run has ended.";

  // A request said on the broker's stream: { run, id, kind, value, reason }. received() resolves
  // once it is decided (the tests'); take() once it is kept, deciding it after (the stream's:
  // a policy decision would hold every other run's events back). Either way read again until
  // it is kept (an error leaves it unacknowledged), and one known already is only told again.
  async function received(event) {
    const decide = await stored(event);
    if (decide) await decide();
  }

  async function take(event) {
    const decide = await stored(event);
    if (decide) {
      decide().catch((error) => log(`Permission requests: ${error.stack ?? error}`));
    }
  }

  // The request kept, in the store too: a copy stopping now finds it undecided (start()). →
  // what decides it, or null when it is closed or known already.
  async function stored({ run, id, kind, value, reason }) {
    if (!ID.test(id ?? "")) return null;
    const known = requests.get(id);
    if (known) {
      if (known.state !== "pending" && !known.told) tell(known);
      return null;
    }
    const task = taskOfRun(run);
    const record = {
      id,
      run,
      key: task?.live.key ?? null,
      chat: null,
      owner: task?.owner ?? null,
      kind: String(kind),
      value: String(value ?? "").slice(0, 256),
      // Redacted as the run's log is: the operator's secrets and the run's own tokens.
      reason: reasonLine(reason, [
        ...(ctx.broker?.secretsOf?.(run) ?? []),
        ...operatorSecrets(ctx),
      ]),
      what: null,
      adds: null,
      live: false,
      state: "pending",
      scope: null,
      message: null,
      at: now(),
      expiresAt: now() + config.chatPermissionMs,
      answeredAt: null,
      by: null,
      told: false,
    };
    requests.set(id, record);
    const closed = async (state, message) => (await close(record, state, message), null);
    if (!task) return closed("denied", "Denied: this sandbox's run has ended.");
    // Only a chat's run may ask (the broker refuses the others first).
    const subject = ctx.chats?.subjectOf?.(task);
    if (!subject || !task.owner) {
      return closed("refused", "Refused: this run may not ask for permissions.");
    }
    record.chat = subject.id;
    busy.add(id);
    try {
      await save({ strict: true });
    } catch (error) {
      // Not in the store: forgotten here, the event left unacknowledged, read again.
      busy.delete(id);
      requests.delete(id);
      throw error;
    }
    return () => first(task, record);
  }

  // A request kept, decided (busy meanwhile, stored() marked it): refused, granted, or held for
  // its owner.
  async function first(task, record) {
    const { id, run } = record;
    busy.add(id);
    let decided;
    try {
      decided = await decide(task, record);
    } finally {
      busy.delete(id);
    }
    // Its run ended meanwhile (ended() left it to this): nobody left to ask.
    if (record.state !== "pending") return;
    if (!taskOfRun(run)) return close(record, "denied", "Denied: this sandbox's run has ended.");
    if (decided.verdict === "ask") {
      // Those that wait for an answer: not those being decided, which may never wait.
      const waiting = [...requests.values()].filter(
        (r) => r.run === run && r.state === "pending" && r.what !== null,
      );
      if (waiting.length >= WAITING_MAX) {
        return close(
          record,
          "refused",
          `Refused: ${WAITING_MAX} requests of yours wait for an answer already; ask again once they have one.`,
        );
      }
      Object.assign(record, { what: decided.what, adds: decided.adds, live: decided.live });
      arm(record);
      await save();
      note(run, `Permission asked: ${record.kind} ${record.what} (waiting for ${record.owner})`);
      log(`${record.key}: asks ${record.owner} for ${record.kind} ${record.what}`);
      return;
    }
    await settle(task, record, decided);
  }

  // `decided` (decide()'s) that needs no question: refused, granted (the sandbox has it), or
  // applied first (its profile had it: a host goes to the sandbox going).
  async function settle(task, record, decided) {
    if (decided.verdict === "saved") {
      Object.assign(record, { what: decided.what, adds: decided.adds, live: decided.live });
      const applied = await ctx.chats.grantRequest(task, record, null, decided.ceiling);
      return close(
        record,
        "granted",
        `Granted: ${record.what}, as this chat's permissions allow. ${applied}`,
      );
    }
    const state = decided.verdict === "given" ? "granted" : "refused";
    return close(record, state, decided.message);
  }

  // The subject's verdict (profiles.mjs requestVerdict()), or a refusal when it can't be
  // decided now (the policies, GitHub or the grants away).
  async function decide(task, record) {
    try {
      return await ctx.chats.decideRequest(task, record);
    } catch (error) {
      return {
        verdict: "invalid",
        message: `Refused: it can't be decided now (${error.message}); ask again later.`,
      };
    }
  }

  // Its answer: kept, said in the run's log, and told to the broker.
  // A record closed already (its run ended, its timeout passed) keeps its first answer, as the
  // broker does.
  async function close(record, state, message, { scope = null, by = null } = {}) {
    if (record.state !== "pending") return;
    clearTimer(timers.get(record.id));
    timers.delete(record.id);
    Object.assign(record, { state, message, scope, by, answeredAt: now() });
    await save();
    note(record.run, `Permission ${record.kind} ${record.what ?? record.value}: ${message}`);
    tell(record);
  }

  // The answer to the broker, again a little later until it takes it, or says the request is
  // gone (its run ended long ago).
  function tell(record) {
    // A machine run's call reads it here (settled()).
    if (record.machine) return wakeUp(record.id);
    if (stopped) return;
    ctx.brokerService
      .answerPermission(record.run, record.id, { state: record.state, message: record.message })
      .then(() => {
        record.told = true;
        return save();
      })
      .catch((error) => {
        log(`Broker: the answer to ${record.id} (${error.message}), telling it again`);
        const timer = setTimer(() => requests.get(record.id) === record && tell(record), retryMs);
        timer?.unref?.();
      });
  }

  // Denied once CHAT_PERMISSION_TIMEOUT passes without an answer.
  function arm(record) {
    clearTimer(timers.get(record.id));
    const timer = setTimer(() => expire(record), Math.max(0, record.expiresAt - now()));
    timer?.unref?.();
    timers.set(record.id, timer);
  }

  function expire(record) {
    timers.delete(record.id);
    if (stopped || record.state !== "pending") return;
    // An answer under way settles it: its owner answered in time.
    if (busy.has(record.id)) return;
    const minutes = minutesOf(config.chatPermissionMs);
    close(record, "denied", `Denied: ${record.owner} didn't answer within ${minutes} min.`).catch(
      (error) => log(`Permission requests: ${error.stack ?? error}`),
    );
  }

  // The owner's answer (`answer`: ANSWERS) to request `id` of their chat `chatId`, from the
  // dashboard (chats.mjs checked whose chat it is). An approval is decided again first: the
  // grants may have changed since it was asked. → the request, answered.
  async function answer(user, chatId, id, choice) {
    const record = ID.test(id ?? "") ? requests.get(id) : null;
    if (!record || record.chat !== chatId) return { error: 404, message: "No such request." };
    if (!ANSWERS.includes(choice)) {
      return { error: 400, message: `An answer is one of ${ANSWERS.join(", ")}.` };
    }
    if (record.state !== "pending") {
      return { error: 409, message: "This request has its answer already." };
    }
    if (busy.has(id)) return { error: 409, message: "This request is being answered already." };
    busy.add(id);
    try {
      return await answering(record, String(user).toLowerCase(), choice);
    } finally {
      busy.delete(id);
      // The answer didn't close it (a failure): its run ended meanwhile, or its timeout passed.
      if (record.state === "pending" && !taskOfRun(record.run)) ended(record.run);
      else if (record.state === "pending" && record.expiresAt <= now()) expire(record);
    }
  }

  // answer()'s, the request held (ended() and its timeout leave it to this): its run ending
  // before the approval applies denies it; once applied, it is granted, as it was.
  const gone = () => ({ error: 409, message: "Its sandbox has stopped: the request is closed." });
  async function answering(record, by, choice) {
    const task = taskOfRun(record.run);
    if (!task) {
      await close(record, "denied", "Denied: this sandbox's run has ended.");
      return gone();
    }
    if (choice === "deny") {
      await close(record, "denied", `Denied by ${by}.`, { by });
      return { request: shown(record) };
    }
    const decided = await decide(task, record);
    if (!taskOfRun(record.run)) {
      await close(record, "denied", "Denied: this sandbox's run has ended.");
      return gone();
    }
    if (decided.verdict !== "ask") {
      await settle(task, record, decided);
      return { request: shown(record) };
    }
    Object.assign(record, { what: decided.what, adds: decided.adds, live: decided.live });
    const applied = await ctx.chats.grantRequest(task, record, choice, decided.ceiling);
    const scope = choice === "chat" ? "for this chat" : "once";
    await close(record, "granted", `Granted by ${by} ${scope}: ${record.what}. ${applied}`, {
      scope: choice,
      by,
    });
    return { request: shown(record) };
  }

  // A run that ended: its requests still waiting are denied (its agent is gone).
  // One being decided or answered is left to that, which closes it as it applied it or not.
  function ended(run) {
    for (const record of requests.values()) {
      if (record.run !== run || record.state !== "pending" || busy.has(record.id)) continue;
      close(record, "denied", endedText(record)).catch((error) =>
        log(`Permission requests: ${error.stack ?? error}`),
      );
    }
  }

  // A chat deleted: its requests go with it.
  function forget(chatId) {
    let changed = false;
    for (const [id, record] of requests) {
      if (record.chat !== chatId) continue;
      clearTimer(timers.get(id));
      timers.delete(id);
      requests.delete(id);
      changed = true;
    }
    if (changed) save();
  }

  // What the dashboard shows of a chat's requests waiting for its owner, oldest first.
  const waitingFor = (chatId) =>
    [...requests.values()]
      // Decided to ask: one still being decided has no question to show yet.
      .filter((r) => r.chat === chatId && r.state === "pending" && r.what !== null)
      .sort((a, b) => a.at - b.at)
      .map(shown);

  const shown = (r) => ({
    id: r.id,
    kind: r.kind,
    what: r.what ?? r.value,
    reason: r.reason,
    live: r.live,
    state: r.state,
    message: r.message,
    at: r.at,
    expiresAt: r.expiresAt,
  });

  // Once the runs a previous copy left are back (restart.mjs): the timeouts armed again, the
  // requests of runs gone denied, the answers the broker hasn't heard told again.
  function start() {
    for (const record of requests.values()) {
      if (record.state !== "pending") {
        if (!record.told) tell(record);
      } else if (!taskOfRun(record.run)) ended(record.run);
      // Kept before its decision, which the copy before didn't finish: decided now.
      else if (record.what === null) {
        first(taskOfRun(record.run), record).catch((error) =>
          log(`Permission requests: ${error.stack ?? error}`),
        );
      } else arm(record);
    }
  }

  function stop() {
    stopped = true;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    // The calls waiting answer "still waiting": their driver asks the next copy.
    for (const id of [...waiters.keys()]) wakeUp(id);
  }

  // --- A machine run's tool calls (#600) ---------------------------------------------------

  // Its agent asks to use a tool (claims.mjs approve(), `task` its claim's): `tool` its name,
  // `input` its input, `toolUseId` the call's id, which a call asked again (its driver waiting on)
  // finds. Allowed at once when its owner allowed that tool for the run; else kept, armed, in the
  // run's log and in a comment on its issue for its owner. → the record.
  async function askTool(task, { tool, input, toolUseId }) {
    const live = task.live;
    const run = live.id;
    const known = [...requests.values()].find((r) => r.run === run && r.toolUseId === toolUseId);
    if (known) return known;
    const name = reasonLine(tool).slice(0, TOOL_MAX);
    const owner = lower(live.external.owner);
    const record = {
      id: newId(),
      run,
      key: live.key,
      chat: null,
      machine: live.external.name,
      toolUseId: String(toolUseId).slice(0, 200),
      owner,
      kind: "tool",
      value: name,
      reason: inputLine(input, operatorSecrets(ctx)),
      what: name,
      adds: null,
      live: false,
      state: "pending",
      scope: null,
      message: null,
      at: now(),
      expiresAt: now() + config.chatPermissionMs,
      answeredAt: null,
      by: null,
      told: true,
    };
    const forRun = [...requests.values()].find(
      (r) => r.run === run && r.scope === "run" && r.state === "granted" && r.what === name,
    );
    const waiting = [...requests.values()].filter((r) => r.run === run && r.state === "pending");
    requests.set(record.id, record);
    if (forRun) {
      await close(record, "granted", `Allowed: ${forRun.by} allowed ${name} for this run.`, {
        scope: "run",
        by: forRun.by,
      });
      return record;
    }
    if (waiting.length >= WAITING_MAX) {
      await close(
        record,
        "refused",
        `Refused: ${WAITING_MAX} requests of this run wait for ${owner}'s answer already; ask again once they have one.`,
      );
      return record;
    }
    arm(record);
    await save();
    note(run, `Permission asked: ${name} ${record.reason} (waiting for ${owner})`);
    log(`${record.key}: ${record.machine} asks ${owner} for ${name}`);
    if (task.kind === "issue") {
      await Promise.resolve(ctx.reply(task.repo, task.number, askText(record))).catch((error) =>
        log(`${record.key}: the request's comment: ${error.message ?? error}`),
      );
    }
    return record;
  }

  // The comment that asks the owner, on the issue: the tool and its input in a block shown as
  // text, how to answer.
  function askText(r) {
    const short = r.id.slice(0, SHORT_ID);
    return [
      `@${r.owner}, the agent on your machine ${r.machine} asks to use a tool (request \`${short}\`):`,
      "",
      fenced(`${r.what}: ${r.reason}`),
      "",
      `Answer with \`/allow\` (this call), \`/allow run\` (that tool's calls for the rest of this run) or \`/deny\`, here or on the dashboard; while other requests wait too, add its id: \`/allow ${short}\`. Without an answer within ${minutesOf(config.chatPermissionMs)} min, it is denied. Only @${r.owner}'s answer counts.`,
    ].join("\n");
  }

  // Request `id`, once answered, or `ms` on: → its record (null once forgotten).
  function settled(id, ms) {
    const record = requests.get(id);
    if (!record || record.state !== "pending" || stopped || ms <= 0) {
      return Promise.resolve(record ?? null);
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimer(timer);
        waiters.get(id)?.delete(done);
        if (!waiters.get(id)?.size) waiters.delete(id);
        resolve(requests.get(id) ?? null);
      };
      const timer = setTimer(done, ms);
      timer?.unref?.();
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(done);
    });
  }

  function wakeUp(id) {
    for (const done of [...(waiters.get(id) ?? [])]) done();
  }

  // The owner's answer (`choice`: TOOL_ANSWERS) to request `id` of task `key`, from the dashboard
  // or a comment: anyone else's refused (403). `run` allows that tool's later calls in the run,
  // and those of its calls that wait already. → { request } or { error, message }.
  async function answerTool(user, key, id, choice) {
    const record = ID.test(id ?? "") ? requests.get(id) : null;
    if (!record?.machine || taskId(record.key) !== taskId(key)) {
      return { error: 404, message: "No such request." };
    }
    const by = lower(user);
    if (by !== record.owner) {
      return { error: 403, message: `Only ${record.owner}, whose machine runs it, answers it.` };
    }
    if (!TOOL_ANSWERS.includes(choice)) {
      return { error: 400, message: `An answer is one of ${TOOL_ANSWERS.join(", ")}.` };
    }
    if (record.state !== "pending") {
      return { error: 409, message: "This request has its answer already." };
    }
    if (!taskOfRun(record.run)) {
      await close(record, "denied", endedText(record));
      return { error: 409, message: "Its run has ended: the request is closed." };
    }
    if (choice === "deny") {
      await close(record, "denied", `Denied by ${by}.`, { by });
      return { request: shownTool(record) };
    }
    const scope = choice === "run" ? "for this run" : "once";
    await close(record, "granted", `Allowed by ${by} ${scope}.`, { scope: choice, by });
    if (choice === "run") {
      const same = [...requests.values()].filter(
        (r) => r.run === record.run && r.state === "pending" && r.what === record.what,
      );
      for (const r of same) {
        await close(r, "granted", `Allowed: ${by} allowed ${r.what} for this run.`, {
          scope: "run",
          by,
        });
      }
    }
    return { request: shownTool(record) };
  }

  // A `/allow` or `/deny` comment (`item.permission`: events.mjs parseAnswer()'s) on a task: its owner's
  // answers the request it names, or the only one waiting, with a 👍; anyone else's is ignored,
  // and so is one on a task with nothing waiting. Never queued, never its agent's.
  async function fromComment(item) {
    const key = `${item.repo}#${item.id}`;
    const author = lower(item.author);
    const waiting = [...requests.values()].filter(
      (r) => r.machine && r.state === "pending" && taskId(r.key) === taskId(key),
    );
    const say = (text) =>
      Promise.resolve(ctx.reply(item.repo, item.replyTo, text)).catch((error) =>
        log(`${key}: ${error.message ?? error}`),
      );
    const owner = waiting[0]?.owner;
    if (!waiting.length || author !== owner) {
      log(
        `${key}: ${item.author}'s /allow or /deny ignored: ${waiting.length ? `only ${owner} answers` : "nothing waits"}`,
      );
      return;
    }
    const asked = item.permission;
    if (asked.error) return say(asked.error);
    const named = asked.id ? waiting.filter((r) => r.id.startsWith(asked.id)) : waiting;
    if (named.length !== 1) {
      const ids = waiting.map((r) => `\`${r.id.slice(0, SHORT_ID)}\` (${r.what})`).join(", ");
      return say(
        named.length
          ? `Several requests wait: ${ids}. Name the one you answer: \`/allow ${waiting[0].id.slice(0, SHORT_ID)}\`.`
          : `No request waiting here starts with \`${asked.id}\`: ${ids}.`,
      );
    }
    const said = await answerTool(author, key, named[0].id, asked.choice);
    if (said.error) return say(said.message);
    await ctx.settle?.(item, "acknowledged");
  }

  // A machine task's requests waiting for its owner, oldest first, as the dashboard shows them.
  const toolRequests = (key) =>
    [...requests.values()]
      .filter((r) => r.machine && r.state === "pending" && taskId(r.key) === taskId(key))
      .sort((a, b) => a.at - b.at)
      .map(shownTool);

  const shownTool = (r) => ({
    id: r.id,
    tool: r.what,
    input: r.reason,
    machine: r.machine,
    owner: r.owner,
    state: r.state,
    message: r.message,
    at: r.at,
    expiresAt: r.expiresAt,
  });

  return {
    load,
    start,
    stop,
    received,
    take,
    answer,
    ended,
    forget,
    waitingFor,
    askTool,
    settled,
    answerTool,
    fromComment,
    toolRequests,
    get: (id) => requests.get(id) ?? null,
  };
}

const minutesOf = (ms) => Math.round(ms / 60_000);
