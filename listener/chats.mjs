// Chats (#476): a user's own conversations with the agent on one of the repositories, started
// from the dashboard rather than from an issue. Each one is a task (tasks.mjs, kind "chat", key
// "<repo>#chat-<id>"), so its runs are any run's (runs.mjs): its sandbox, tokens, capabilities,
// inbox and log, and a restart picks them up (restart.mjs). What is a chat's own is here, kept in
// the orchestrator's store (lib/store.mjs, CHATS_KEY), which its two copies share: the next one
// reads it once it holds the lease (load()), after a restart or a handover:
//
// - its owner, the only one who lists it, reads its runs' logs (http.mjs) and reaches it;
// - its repository, which brings the image, grants and users, and its agent, model and effort;
// - its lifecycle: the first message starts its sandbox, in the `chats` pool (tasks.mjs, its
//   MAX_RUNNING_CHATS slots), the next ones go to its inbox (tasks.mjs deliver()), and
//   CHAT_IDLE_MINUTES after the last message or the last answer, whichever came later, its inbox
//   closes and the sandbox stops (runs.mjs rest()); the next message starts it again in the same
//   session, from its own volumes (light-like: never shared with the repository's work runs,
//   modes.mjs);
// - who may chat: ALLOWED_USERS, the repository's `users` and the access decision
//   (permissions.mjs), `runs:start:chat` there, as any start from the dashboard;
// - CHATS_PER_USER, which a repository's `chats.per_user` may lower, counted across the
//   repositories;
// - its reset (its volumes and session dropped, the chat kept) and its deletion.
//
// What its runs may do is the policies' (../policy/mode-chat.rego): no GitHub write, no push. Its
// owner narrows that with its permissions profile (#478, profiles.mjs), kept with the chat and
// checked against what the policies and the grants give on every save and at every start
// (preparation.mjs). Its agent asks for more within that ceiling (#479, requests.mjs): what its
// owner approves goes to its sandbox (a host) or its profile, or to its next start alone.
import { randomBytes } from "node:crypto";
import { runOutcome } from "./capabilities.mjs";
import { MODEL_TIERS, repoAllowed } from "./config.mjs";
import { EFFORTS, MODEL_NAME, taskKey } from "./events.mjs";
import { removeRun } from "./history.mjs";
import { refusal as accessRefusal, startAction } from "./permissions.mjs";
import { entryLabel, pickable, pickProblem } from "./agents/select.mjs";
import {
  ceilingOf,
  checkProfile,
  DEFAULT_PROFILE,
  narrowProfile,
  requestVerdict,
  widened,
} from "./profiles.mjs";
import { sandboxName } from "./repo-config.mjs";
import { queueId } from "./restart.mjs";
import { publicRun } from "./runlog.mjs";
import { CHATS, newTask } from "./tasks.mjs";
import { apiRoute, hidden, mustDo } from "./web.mjs";
import { readJsonBody, Refused, refuse, send } from "../lib/http.mjs";

// The store's key of the chats: all of them, as one value (the store lists no keys).
const CHATS_KEY = "chats";

// A chat's id: 16 hex digits (the runner checks a chat's key by them: ../runner/spec-check.mjs
// chatSandbox()).
const CHAT_ID = /^[0-9a-f]{16}$/;
// What a message may hold, and its request.
const MAX_TEXT = 32_000;
const MAX_BODY = 128 * 1024;
// How often the chats going are checked against ALLOWED_USERS and their repository's `users`.
const CHECK_MS = 60_000;
// How soon an idle chat whose message still waits for a slot, or whose sandbox starts, is
// looked at again.
const RETRY_MS = 60_000;
// How long a reset or a deletion waits for the chat's sandbox to be gone.
const STOP_WAIT_MS = 120_000;

// What a chat's owner needs on its repository (permissions.mjs): to start its runs, and to read
// their logs, its conversation.
const START = startAction("chat");
const LOGS = "logs:read";

// The chat's task id and key, as tasks.mjs and runs.mjs have them.
const chatTaskId = (id) => `chat-${id}`;
export const chatKey = (chat) => taskKey(chat.repo, chatTaskId(chat.id));

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time;
// `ctx.store` keeps the chats. `checks`: repo-check.mjs's, the dashboard's other actions' (the App installed, a config
// without errors, the user among the repo's users). `now`, the timers and `sleep`: the tests'.
export function createChats(
  ctx,
  {
    checks,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    every = setInterval,
    stopEvery = clearInterval,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    checkMs = CHECK_MS,
    stopWaitMs = STOP_WAIT_MS,
  },
) {
  const { config, log } = ctx;
  // id → { id, owner, repo, base, agent, model, effort, title, createdAt, lastActiveAt,
  // resetAt, profile, once }: the owner's login in lower case, as edge signs users in; `profile`,
  // its permissions profile (profiles.mjs), null for the default (everything its ceiling
  // allows); `once`, what its owner approved once that applies at a start (#479: the engine, a
  // mount), for its next start alone (startProfile()).
  const chats = new Map();
  // id → its idle timer, and when its run last answered (in memory: after a restart, its idle
  // time counts from its last message); the chats being reset or deleted, which take no message
  // meanwhile.
  const timers = new Map();
  const answered = new Map();
  const busy = new Set();
  let sweeping = null;

  // Back from the store, once this copy holds the lease (server.mjs), before any request.
  async function load() {
    const saved = (await ctx.store.get(CHATS_KEY)) ?? {};
    chats.clear();
    for (const [id, chat] of Object.entries(saved)) if (CHAT_ID.test(id)) chats.set(id, chat);
  }

  // The chats, whole, in the store: one write after the other, the latest state when each begins.
  // Resolves once written; a failed write is logged, and the next one has it.
  let saving = Promise.resolve();
  function save() {
    saving = saving.then(() =>
      ctx.store
        .set(CHATS_KEY, Object.fromEntries(chats))
        .catch((error) => log(`Saving the chats: ${error.stack ?? error}`)),
    );
    return saving;
  }

  const own = (chat, user) => chat.owner === String(user).toLowerCase();

  // The user's chat `id`, or a 404: someone else's isn't said to exist.
  function mine(user, id) {
    const chat = CHAT_ID.test(id ?? "") ? chats.get(id) : null;
    if (!chat || !own(chat, user)) refuse(404, "No such chat.");
    return chat;
  }

  // Its task, made the first time its message is queued (newTask()), or null.
  const taskOf = (chat) => ctx.tasks.get(chatKey(chat)) ?? null;
  function ensureTask(chat) {
    const key = chatKey(chat);
    let task = ctx.tasks.get(key);
    if (!task) {
      const id = chatTaskId(chat.id);
      task = newTask({
        repo: chat.repo,
        id,
        kind: "chat",
        number: null,
        base: chat.base,
        name: sandboxName(config, chat.repo, id),
        settings: null,
        // Its owner's alone (http.mjs), in the chats' slots.
        owner: chat.owner,
        pool: CHATS,
      });
      ctx.tasks.set(key, task);
    }
    return task;
  }

  // "running" while its agent works on a message (or its sandbox starts, or a message waits for
  // a slot), "idle" while its sandbox waits for the next one, "stopped" without a sandbox.
  function statusOf(chat) {
    const task = taskOf(chat);
    if (!task || (!task.running && !task.pending.length)) return "stopped";
    const live = task.live;
    if (live?.open && live.result && !live.unanswered.length && !task.pending.length) {
      return "idle";
    }
    return "running";
  }

  // Whether its owner may still reach it: ALLOWED_REPOS, ALLOWED_USERS and the repo's `users` as
  // the orchestrator last read them (refusal()), and `logs:read` there (a decision that failed
  // reaches nothing, as http.mjs refuses its logs then).
  async function reachable(chat) {
    if (refusal(chat)) return false;
    return !ctx.permissions || (await ctx.permissions.decide(chat.owner, chat.repo, LOGS)).ok;
  }

  // What the dashboard shows of a chat: its runs (their logs are its conversation) newest first.
  // A chat its owner can no longer reach shows without them (its logs are refused too,
  // http.mjs), so that they can still delete it.
  async function view(chat) {
    const task = taskOf(chat);
    const open = await reachable(chat);
    return {
      ...chat,
      status: statusOf(chat),
      // A message waiting for one of MAX_RUNNING_CHATS.
      queued: !!task && !task.running && task.pending.length > 0,
      // Its messages not delivered yet (a sandbox starting or resuming, a slot to wait for): the
      // conversation shows them until its run's log has them (runlog.mjs, "message").
      pending: task ? task.pending.map((i) => ({ text: i.text, queuedAt: i.queuedAt })) : [],
      // Its agent's requests for more permissions, waiting for its owner (requests.mjs).
      requests: open ? (ctx.requests?.waitingFor(chat.id) ?? []) : [],
      reachable: open,
      runs: open ? ctx.runs.filter((r) => r.chat === chat.id).map(publicRun) : [],
    };
  }

  function list(user) {
    const mine = [...chats.values()]
      .filter((chat) => own(chat, user))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return Promise.all(mine.map(view));
  }

  // The repositories New chat offers `user`: those the App lists, in ALLOWED_REPOS, among whose
  // `users` they are, with `runs:start:chat` there. What create() checks again, and more (the
  // App installed, the config's errors).
  async function startable(user) {
    const login = String(user).toLowerCase();
    if (!config.users.includes(login)) return [];
    const names = (ctx.repoList?.listed() ?? []).filter((repo) => {
      const users = ctx.usersOf?.(repo);
      return repoAllowed(config, repo) && (!users || users.includes(login));
    });
    if (!ctx.permissions) return names.toSorted();
    const can = await ctx.permissions.which(login, names, START);
    return names.filter((repo) => can.has(repo.toLowerCase())).toSorted();
  }

  // GET /api/chats: the user's chats, how many they may keep (a repository's `chats.per_user`
  // may lower it there: create() says so), and what New chat offers: the repositories, the
  // agents the operator configured (`default`: the repository's), the models' tiers and the
  // efforts.
  async function listed(user) {
    return {
      chats: await list(user),
      limit: config.chatsPerUser,
      repos: await startable(user),
      agents: pickable(config).map((name) => ({ name, label: entryLabel(name) })),
      models: MODEL_TIERS,
      efforts: EFFORTS,
    };
  }

  // The agent, model and effort a chat was created with, each that it names (runs.mjs begin(),
  // under the "/model" lines of its messages).
  function options(task) {
    const chat = chats.get(task.id.slice("chat-".length));
    if (!chat) return {};
    return Object.fromEntries(
      ["agent", "model", "effort"].filter((k) => chat[k]).map((k) => [k, chat[k]]),
    );
  }

  // The checks of the dashboard's other actions on `repo`: as a route of theirs (web.mjs
  // apiRoute()), a repo the user doesn't see answers as one outside ALLOWED_REPOS, one without
  // `runs:start:chat` a 403 and one whose access can't be decided a 503; then repo-check.mjs
  // checkedRepo(), as GitHub spells it. → { settings, base, repo }.
  async function checked(repo, user) {
    if (!repoAllowed(config, repo)) refuse(404, hidden(repo).error);
    if (ctx.permissions) {
      const sees = await ctx.permissions.decide(user, repo, null);
      // Undecided (a policy error, the policy service away): a 503, which stops nothing
      // (message()), rather than a hidden repo's 404.
      if (sees.error) {
        log(`Chats: ${repo}: ${accessRefusal(sees, user, null)}`);
        refuse(503, `Your access to ${repo} can't be decided now; try again later.`);
      }
      if (!sees.ok) refuse(404, hidden(repo).error);
      await mustDo(ctx.permissions, user, repo, START);
    }
    const name = await checks.nameOf(repo);
    return { ...(await checks.checkedRepo(name, user)), repo: name };
  }

  // A new chat on `repo` for `user`: { repo, agent, model, effort, message }, the last four
  // optional. Refused past CHATS_PER_USER, or the repo's lower `chats.per_user`, counting the
  // user's chats on every repository.
  async function create(user, body) {
    const { repo: asked, agent = null, model = null, effort = null, message = null } = body ?? {};
    if (typeof asked !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(asked)) {
      refuse(400, "Which repository? (owner/name)");
    }
    if (agent !== null) {
      const problem = typeof agent === "string" ? pickProblem(config, agent) : "not a name";
      if (problem) refuse(422, `The agent: ${problem}.`);
    }
    if (model !== null && (typeof model !== "string" || !MODEL_NAME.test(model))) {
      refuse(422, "The model: a tier (best, balanced, fast) or a model's name.");
    }
    if (effort !== null && !EFFORTS.includes(effort)) {
      refuse(422, `The effort: one of ${EFFORTS.join(", ")}.`);
    }
    if (message !== null) textOf(message);
    if (message !== null) runnable();
    const { settings, base, repo } = await checked(asked, user);
    const limit = settings.chatsPerUser ?? config.chatsPerUser;
    const kept = [...chats.values()].filter((chat) => own(chat, user)).length;
    if (kept >= limit) {
      const why =
        limit < config.chatsPerUser
          ? `${repo}'s \`chats.per_user\` allows ${limit}`
          : `CHATS_PER_USER is ${limit}`;
      refuse(
        409,
        limit === 0
          ? `No chats on ${repo}: ${why}.`
          : `You have ${kept} chat(s), the most you may keep (${why}): delete one first.`,
      );
    }
    let id;
    do id = randomBytes(8).toString("hex");
    while (chats.has(id));
    const at = now();
    const chat = {
      id,
      owner: String(user).toLowerCase(),
      repo,
      base,
      agent: agent === "default" ? null : agent,
      model,
      effort,
      title: null,
      createdAt: at,
      lastActiveAt: at,
      resetAt: null,
      profile: null,
    };
    chats.set(id, chat);
    await save();
    log(`${chatKey(chat)}: chat created by ${user}`);
    if (message !== null) await queue(chat, user, message, settings, base);
    return chat;
  }

  // Refuses a message to a chat being reset or deleted, gone, or reset since `resetAt` (when the
  // message came: it was written to the conversation the reset dropped).
  function open(chat, resetAt = chat.resetAt) {
    if (busy.has(chat.id) || chats.get(chat.id) !== chat || chat.resetAt !== resetAt) {
      refuse(409, "This chat is being reset or deleted: send it again in a moment.");
    }
  }

  // MAX_RUNNING_CHATS 0: no chat runs, so a message would wait for good.
  function runnable() {
    if (config.maxRunningChats === 0) refuse(409, "No chat runs here: MAX_RUNNING_CHATS is 0.");
  }

  function textOf(message) {
    if (typeof message !== "string" || !message.trim()) refuse(400, "An empty message.");
    if (message.length > MAX_TEXT) refuse(413, `A message holds ${MAX_TEXT} characters at most.`);
    return message;
  }

  // The user's next message: it starts the chat's sandbox, or goes to the one waiting for it.
  // Refused, and a sandbox still going stopped, once the user may no longer run the agent there
  // (ALLOWED_USERS, the repo's `users`, the access decision, its config's errors); a decision
  // that failed refuses the message alone.
  async function message(user, id, text) {
    const chat = mine(user, id);
    textOf(text);
    runnable();
    open(chat);
    const { resetAt } = chat;
    let read;
    try {
      read = await checked(chat.repo, user);
    } catch (error) {
      if (error instanceof Refused && (error.status === 403 || error.status === 404)) {
        stop(chat, "no longer allowed");
      }
      throw error;
    }
    // Reset or deleted while its checks read: a deleted chat's message would start a sandbox
    // nothing stops (its task out of `chats`).
    open(chat, resetAt);
    await queue(chat, user, text, read.settings, read.base);
    return view(chat);
  }

  // `text` queued as the chat's message, like a comment (tasks.mjs queue()): delivered to its
  // sandbox when it waits for one, else its next run's.
  async function queue(chat, user, text, settings, base) {
    const { resetAt } = chat;
    chat.base = base;
    chat.lastActiveAt = now();
    chat.title ??= titleOf(text);
    await save();
    // Its task made once the save is done, and only if the chat wasn't reset or deleted
    // meanwhile.
    open(chat, resetAt);
    const task = ensureTask(chat);
    task.settings = settings;
    task.base = base;
    task.pending.push(messageItem(chat, user, text));
    // In the store at once (restart.mjs): a listener killed now doesn't lose it.
    ctx.saveQueue?.();
    if (!task.running) ctx.startLater(task);
    else if (ctx.deliverable(task) === task.pending.length) ctx.deliverLater(task);
    else if (answeredClosed(task.live)) {
      // A run restored with its inbox not known open (restart.mjs) that has answered: it takes
      // no message, so it rests now (it lingers out) and the message starts the next one,
      // rather than waiting for its idle time, which each message would push further.
      ctx.rest(task);
    }
    arm(chat);
  }

  // The item `user`'s message `text` queues, like a comment's (tasks.mjs): what its run's
  // capabilities are decided from too, so ceiling() reads the one its next run starts with.
  const messageItem = (chat, user, text) => ({
    repo: chat.repo,
    id: chatTaskId(chat.id),
    kind: "chat",
    number: null,
    author: String(user).toLowerCase(),
    text,
    mode: "chat",
    replyTo: null,
    dashboard: true,
    queuedAt: now(),
    queueId: queueId(),
  });

  const answeredClosed = (live) =>
    !!live &&
    !live.open &&
    !live.answered &&
    !live.finishing &&
    !live.cancelled &&
    !!live.result &&
    !live.unanswered?.length;

  // When the chat goes idle: CHAT_IDLE_MINUTES after its last message (`lastActiveAt`) or its
  // run's last answer, whichever came later. A message that waited for a slot has its answer
  // after it: the idle time counts from there.
  const idleAt = (chat) =>
    Math.max(chat.lastActiveAt, answered.get(chat.id) ?? 0) + config.chatIdleMs;

  // Its run answered (run-output.mjs output()): the idle timer from now.
  function answer(task) {
    const chat = chats.get(task.id.slice("chat-".length));
    if (!chat) return;
    answered.set(chat.id, now());
    arm(chat);
  }

  // (Re)arms the chat's idle timer (idleAt()).
  function arm(chat, at = idleAt(chat)) {
    clearTimer(timers.get(chat.id));
    const timer = setTimer(() => idle(chat), Math.max(0, at - now()));
    timer?.unref?.();
    timers.set(chat.id, timer);
  }

  // No message for CHAT_IDLE_MINUTES: its sandbox's inbox closes, and the sandbox stops once its
  // agent has answered (runs.mjs rest()). A message since then armed the timer again.
  function idle(chat) {
    timers.delete(chat.id);
    if (ctx.stopping || chats.get(chat.id) !== chat) return;
    if (now() < idleAt(chat)) return arm(chat);
    const task = taskOf(chat);
    const live = task?.live;
    // A message waiting for a slot, or a sandbox starting: its answer arms the timer again, and
    // so does this, should none come.
    if (!live && (task?.running || task?.pending.length)) return arm(chat, now() + RETRY_MS);
    if (!live || live.finishing || live.cancelled) return;
    if (ctx.rest(task)) {
      log(`${chatKey(chat)}: idle for ${config.chatIdleMs / 60_000} min, its sandbox stops`);
    }
  }

  // Its run stopped (run-end.mjs cancel()) and its queued messages dropped: `why` in the log.
  // → whether something was stopped.
  function stop(chat, why) {
    const task = taskOf(chat);
    if (!task) return false;
    const stopped = ctx.cancel(chatKey(chat), "Deckhand");
    if (stopped) log(`${chatKey(chat)}: stopped, ${why}`);
    return !!stopped;
  }

  // Once the chat's sandbox is gone (stop(), then its run's end), for at most `stopWaitMs`.
  async function stopped(chat, why) {
    stop(chat, why);
    const until = now() + stopWaitMs;
    for (let task = taskOf(chat); task?.running; task = taskOf(chat)) {
      if (now() > until)
        refuse(409, "The chat's sandbox is still stopping: try again in a moment.");
      // A message queued meanwhile: dropped too.
      if (task.pending.length && !task.live) stop(chat, why);
      await sleep(250);
    }
  }

  // Its volumes and session gone, the chat kept: the next message starts from a fresh clone.
  async function reset(user, id) {
    const chat = mine(user, id);
    await exclusive(id, async () => {
      await stopped(chat, "reset by its owner");
      const task = ensureTask(chat);
      const removed = await ctx.runner.removeSessions(task.name, chatKey(chat));
      task.next = {};
      chat.resetAt = now();
      await save();
      log(`${chatKey(chat)}: reset (${removed?.length ?? 0} volume(s) removed)`);
    });
    return view(chat);
  }

  // The chat, its volumes, its runs' logs and its task gone.
  async function remove(user, id) {
    const chat = mine(user, id);
    await exclusive(id, async () => {
      await stopped(chat, "deleted by its owner");
      const key = chatKey(chat);
      const task = ensureTask(chat);
      await ctx.runner.removeSessions(task.name, key);
      for (const run of ctx.runs.filter((r) => r.chat === id)) {
        const gone = await removeRun(run, {
          byId: ctx.runsById,
          store: ctx.store,
          removeLog: (runId) => ctx.runLogs.remove(runId),
          removeShots: (folder) => ctx.removeShots(folder),
          log,
        });
        if (gone) ctx.runs.splice(ctx.runs.indexOf(run), 1);
      }
      if (!ctx.tasks.get(key)?.running) ctx.tasks.delete(key);
      clearTimer(timers.get(id));
      timers.delete(id);
      chats.delete(id);
      answered.delete(id);
      ctx.requests?.forget(id);
      await save();
      ctx.saveQueue?.();
      log(`${key}: chat deleted`);
    });
  }

  // `fn()` with the chat's messages refused meanwhile, and no other reset or deletion.
  async function exclusive(id, fn) {
    if (busy.has(id)) refuse(409, "This chat is being reset or deleted already.");
    busy.add(id);
    try {
      await fn();
    } finally {
      busy.delete(id);
    }
  }

  // What `chat`'s profile may hold (profiles.mjs ceilingOf()): what a `chat` run of its
  // repository gets now, from its policies on its default branch, its config and the operator's
  // grant, as its next run starts with them (capabilities.mjs runOutcome(), from the item its
  // message queues: messageItem()), after the checks of a message (checked()). → { ceiling,
  // errors }: `errors`, what would stop its next run whatever its profile.
  async function ceiling(chat, user) {
    const { settings, base, isPrivate } = await checked(chat.repo, user);
    if (!ctx.policies) refuse(503, "No policies to decide what a chat gets.");
    const decided = await runOutcome(ctx, {
      repo: { name: chat.repo, private: isPrivate },
      base,
      settings,
      mode: "chat",
      item: messageItem(chat, user, ""),
      fork: false,
    });
    if (decided.error) {
      refuse(503, `What ${chat.repo}'s chats get can't be decided now: ${decided.error}`);
    }
    if (decided.grantsError) {
      log(`Chats: ${chat.repo}: ${decided.grantsError.error.message}`);
      refuse(503, "The operator's grants folder has errors: no chat starts until they are fixed.");
    }
    const { outcome, check } = decided;
    const limit = ceilingOf({
      outcome,
      grant: check.grant,
      mounts: check.mounts.mounts,
      engine: !!config.engine,
    });
    return { ceiling: limit, errors: outcome.errors.map((e) => e.replaceAll("`", "")) };
  }

  // The chat's permissions as its panel shows them: its saved profile, the ceiling, what its
  // next run gets of it (narrowProfile()), and whether a sandbox is going (it keeps the
  // permissions it started with).
  async function permissions(user, id) {
    const chat = mine(user, id);
    const { ceiling: limit, errors } = await ceiling(chat, user);
    return {
      profile: { ...DEFAULT_PROFILE, ...chat.profile },
      ceiling: limit,
      effective: narrowProfile(chat.profile, limit),
      errors,
      running: statusOf(chat) !== "stopped",
    };
  }

  // A new profile for the chat, saved only within its ceiling: what goes beyond it is refused
  // (a 422 listing each), never dropped quietly. It applies at its sandbox's next start.
  // → permissions()'s, or { refused: [what goes beyond it] }.
  async function setPermissions(user, id, body) {
    const chat = mine(user, id);
    open(chat);
    const { ceiling: limit } = await ceiling(chat, user);
    const { profile, errors } = checkProfile(body?.profile, limit);
    if (errors.length) return { refused: errors };
    open(chat);
    chat.profile = profile;
    await save();
    log(`${chatKey(chat)}: permissions profile changed by ${user}`);
    return permissions(user, id);
  }

  // Its sandbox stopped once its agent has answered (runs.mjs rest()), its session kept: the
  // next message starts it again, with the permissions saved now. Its owner's session only, as
  // reset(): it starts nothing (the next message is checked as any), and a user who lost access
  // can still stop what they left going. → "rested", "stopping" (it had answered already and is
  // on its way out: a message waits for its end), or null (no sandbox going).
  function restart(user, id) {
    const chat = mine(user, id);
    open(chat);
    const live = taskOf(chat)?.live;
    if (!live) return null;
    if (live.answered || live.finishing || live.cancelled) return "stopping";
    if (!ctx.rest(taskOf(chat))) return null;
    log(`${chatKey(chat)}: restarted by its owner, for its permissions`);
    return "rested";
  }

  // --- Its agent's requests for more permissions (#479, requests.mjs) ----------------------

  // The chat a run is of, as the subject of its requests: null for any other run.
  const subjectOf = (task) =>
    task.kind === "chat" ? (chats.get(task.id.slice("chat-".length)) ?? null) : null;

  // A request ({ kind, value }) of the chat's run, against its ceiling now (ceiling(), which
  // refuses when it can't be decided), its profile and what its sandbox has (preparation.mjs:
  // its hosts, mounts and engine) → profiles.mjs requestVerdict()'s, with that ceiling.
  async function decideRequest(task, request) {
    const chat = subjectOf(task);
    if (!chat) refuse(404, "No such chat.");
    const { ceiling: limit } = await ceiling(chat, chat.owner);
    const { live } = task;
    const verdict = requestVerdict(request, {
      ceiling: limit,
      profile: chat.profile,
      live: {
        hosts: live?.hosts ?? null,
        mounts: live?.mounts ?? [],
        engine: !!live?.engine,
        // With the open internet, no host mount (preparation.mjs).
        internet: !!live?.capabilities?.includes("internet"),
      },
    });
    return { ...verdict, ceiling: limit };
  }

  // Request `record` approved (decideRequest()'s `adds` and `live` on it): a host goes to the
  // sandbox going at once (the egress proxy reads `live.hosts` on each connection), and
  // `scope` "chat" saves it in the profile (within `limit`, the ceiling it was decided with),
  // "once" keeps what applies only at a start for the next one; null (its profile had it): the
  // host alone. → what the agent is told of when it applies.
  async function grantRequest(task, record, scope, limit) {
    const chat = subjectOf(task);
    if (!chat) refuse(404, "No such chat.");
    // The profile checked first: a refusal changes nothing, the sandbox's hosts included.
    const kept = scope === "chat" && checkProfile(widened(chat.profile, record.adds), limit);
    if (kept && kept.errors.length) {
      refuse(409, `It no longer fits this chat's ceiling: ${kept.errors.join("; ")}`);
    }
    const live = task.live;
    if (record.live && live?.hosts) {
      for (const host of record.adds.hosts ?? []) {
        if (!live.hosts.includes(host)) live.hosts = [...live.hosts, host];
        if (live.trusted && !live.trusted.includes(host)) live.trusted = [...live.trusted, host];
      }
      ctx.saveLive?.(task);
    }
    if (kept) chat.profile = kept.profile;
    else if (scope === "once" && !record.live) {
      chat.once = widened(chat.once ?? { capabilities: [], hosts: [], mounts: [] }, record.adds);
    }
    if (scope) {
      await save();
      log(`${chatKey(chat)}: ${record.kind} ${record.what} approved (${scope}) by ${chat.owner}`);
    }
    return record.live ? APPLIES.now : APPLIES.next;
  }

  // The profile a chat's next start gets (preparation.mjs): its saved one, with what its owner
  // approved once for it, which this start uses up once its preparation is through
  // (spentOnce()): a start that fails before keeps it for the next one.
  function startProfile(task) {
    const chat = subjectOf(task);
    if (!chat) return null;
    if (task.live) task.live.once = chat.once ?? null;
    if (!chat.once) return chat.profile ?? null;
    return widened(chat.profile, chat.once);
  }

  // The start that read it (startProfile()) is prepared: what was approved once is used up,
  // unless the owner approved more once since (a new value).
  function spentOnce(task) {
    const chat = subjectOf(task);
    const used = task.live?.once;
    // By value: after a handover, each comes from a store of its own.
    if (!chat || !used || JSON.stringify(chat.once) !== JSON.stringify(used)) return;
    chat.once = null;
    save();
  }

  // The chats going whose owner may no longer run the agent on their repository: stopped. Every
  // CHECK_MS, from what the orchestrator read of the repos' `users` last (ctx.usersOf()) and the
  // access decision (a decision that failed stops nothing, as runs.mjs keeps a queued comment
  // then); a message reads them again (checked()).
  async function sweep() {
    for (const chat of chats.values()) {
      const task = taskOf(chat);
      if (!task?.running && !task?.pending.length) continue;
      const why = refusal(chat) ?? (await denied(chat));
      if (why) stop(chat, why);
    }
  }

  async function denied(chat) {
    if (!ctx.permissions) return null;
    const said = await ctx.permissions.decide(chat.owner, chat.repo, START);
    return said.ok || said.error ? null : accessRefusal(said, chat.owner, START);
  }

  const sweepLogged = () => sweep().catch((error) => log(`Chats: ${error.stack ?? error}`));

  function refusal(chat) {
    if (!repoAllowed(config, chat.repo)) return `${chat.repo} is no longer in ALLOWED_REPOS`;
    if (!config.users.includes(chat.owner)) return `${chat.owner} is no longer in ALLOWED_USERS`;
    const users = ctx.usersOf?.(chat.repo);
    if (users && !users.includes(chat.owner)) {
      return `${chat.owner} is no longer among ${chat.repo}'s users`;
    }
    return null;
  }

  // Once the runs a previous orchestrator left are back (restart.mjs): the idle timers armed
  // again from each chat's last message, and the checks of who may go on.
  function start() {
    for (const chat of chats.values()) arm(chat);
    sweepLogged();
    sweeping = every(sweepLogged, checkMs);
    sweeping?.unref?.();
  }

  function stopAll() {
    stopEvery(sweeping);
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }

  // One spelling per repo (spelling.mjs, at a restart), as the queue's tasks have it.
  function respell(spelled) {
    let changed = false;
    for (const chat of chats.values()) {
      const repo = spelled(chat.repo);
      if (repo !== chat.repo) [chat.repo, changed] = [repo, true];
    }
    if (changed) save();
  }

  // The API: GET /api/chats (the caller's), POST /api/chats (a new one), POST
  // /api/chats/<id>/messages, POST /api/chats/<id>/reset, DELETE /api/chats/<id>; GET and POST
  // /api/chats/<id>/permissions (its profile), POST /api/chats/<id>/restart, POST
  // /api/chats/<id>/requests/<request> (an answer to its agent's request).
  const handle = apiRoute({
    name: "Chats",
    route: (pathname) => {
      if (pathname === "/api/chats") return { what: "chats" };
      const asked = /^\/api\/chats\/([^/]+)\/requests\/([^/]+)$/.exec(pathname);
      if (asked) return { what: "request", id: asked[1], request: asked[2] };
      const m = /^\/api\/chats\/([^/]+)(?:\/(messages|reset|permissions|restart))?$/.exec(pathname);
      return m && { what: m[2] ?? "chat", id: m[1] };
    },
    gets: {
      chats: async (req, res, user) => send(res, 200, await listed(user)),
      chat: async (req, res, user, _, { id }) =>
        send(res, 200, { chat: await view(mine(user, id)) }),
      permissions: async (req, res, user, _, { id }) => send(res, 200, await permissions(user, id)),
    },
    posts: {
      chats: async (req, res, user) => {
        const chat = await create(user, await readJsonBody(req, MAX_BODY));
        send(res, 201, { chat: await view(chat) });
      },
      messages: async (req, res, user, _, { id }) => {
        const body = await readJsonBody(req, MAX_BODY);
        send(res, 202, { chat: await message(user, id, body?.text) });
      },
      reset: async (req, res, user, _, { id }) => send(res, 200, { chat: await reset(user, id) }),
      permissions: async (req, res, user, _, { id }) => {
        const said = await setPermissions(user, id, await readJsonBody(req, MAX_BODY));
        if (said.refused) {
          return send(res, 422, {
            error: `This profile goes beyond what the chat may get: ${said.refused.join("; ")}.`,
            errors: said.refused,
          });
        }
        send(res, 200, said);
      },
      // The owner's answer to its agent's request (requests.mjs): { answer: once, chat, deny }.
      request: async (req, res, user, _, { id, request }) => {
        const chat = mine(user, id);
        const { answer: choice } = (await readJsonBody(req, MAX_BODY)) ?? {};
        if (!ctx.requests) refuse(503, "No requests here.");
        const said = await ctx.requests.answer(user, chat.id, request, choice);
        if (said.error) refuse(said.error, said.message);
        send(res, 200, { request: said.request, chat: await view(chat) });
      },
      restart: async (req, res, user, _, { id }) => {
        const said = restart(user, id);
        send(res, 200, {
          chat: await view(mine(user, id)),
          message: RESTARTED[said ?? "none"],
        });
      },
    },
    deletes: {
      chat: async (req, res, user, _, { id }) => {
        await remove(user, id);
        send(res, 200, { message: "Chat deleted." });
      },
    },
    publicUrl: ctx.publicUrl,
    log,
  });

  return {
    handle,
    load,
    answered: answer,
    has: (key) => [...chats.values()].some((chat) => chatKey(chat) === key),
    keys: () => [...chats.values()].map(chatKey),
    respell,
    options,
    profileOf: (task) => chats.get(task.id.slice("chat-".length))?.profile ?? null,
    startProfile,
    spentOnce,
    subjectOf,
    decideRequest,
    grantRequest,
    list,
    listed,
    create,
    message,
    reset,
    remove,
    permissions,
    setPermissions,
    restart,
    sweep,
    start,
    stop: stopAll,
  };
}

// What POST /api/chats/<id>/restart says, by restart()'s answer.
const RESTARTED = {
  rested:
    "Its sandbox stops once its agent has answered: your next message starts it again with these permissions, in the same session.",
  stopping:
    "Its sandbox is already stopping: your next message starts it again with these permissions, in the same session.",
  none: "No sandbox is going: your next message starts one with these permissions.",
};

// What an approved request tells the agent of when it applies (grantRequest()).
const APPLIES = {
  now: "It applies to this sandbox now: no restart needed.",
  next: "It applies when this chat's sandbox starts again: this one doesn't have it. Tell the user, who restarts it from the chat's permissions panel (Restart now) once you have answered; the conversation goes on in the same session.",
};

// A chat's title, for the dashboard: its first message's first line, clipped.
function titleOf(text) {
  const line = text.trim().split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
