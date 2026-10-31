// Auto-pickup (#546): the open issues labelled AUTO_PICKUP_LABEL in the repos whose
// `auto_pickup` opts in are started by the listener itself, oldest created first, in the
// AUTO_PICKUP_SLOTS reserved within MAX_PARALLEL (repo-config.mjs startable()). A sweep looks
// every SWEEP_MS, soon after a picked run ends or the label is added, and fills the reserved
// slots that are free.
//
// An issue is picked only when nothing holds it: an open issue with nothing live on the
// dashboard (board.mjs isLive(): running, queued, waiting, asking…), without the needs-input
// label, with no open "blocked by" issue and no open pull request of Deckhand's for it. The run
// is the work of the person who last added the label (its `labeled` event), who must be in
// the operator's and the repo's users: a label a bot or someone else added starts nothing. The
// App's comment says so, then the label comes off right before the run is queued, so a failed
// or stopped run isn't picked again and again: a person adds it back to retry. The label
// vouches for the issue as it was then: a title or description edited since, by anyone but an
// allowed user, holds it until someone adds the label again (editedSince()). An issue its
// labelling holds keeps the label, and the App's comment says why, once (tell()).
import { hasLabel, headInRepo, issueItem, linkedIssue, MARKER, taskKey } from "./events.mjs";
import { graphql, paginate } from "./github.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";

export const SWEEP_MS = 5 * 60000;
// After a picked run ends or the label is added: a short wait, so a burst is one sweep, and an
// `issues` delivery has its label listed by then.
export const SOON_MS = 5000;

const lower = (s) => String(s ?? "").toLowerCase();

// Who last added `label` to the issue, from its events (oldest first, as GitHub lists them):
// { login, bot, at }, or null when no event says. An issue listed with the label whose last
// event for it took it off (or that has none) has a labelling its events don't show yet: not
// an earlier labeller's, whose label came off since (a picked run's).
export function labeller(events, label) {
  const mine = events.filter(
    (e) => ["labeled", "unlabeled"].includes(e.event) && lower(e.label?.name) === lower(label),
  );
  const last = mine.at(-1);
  if (last?.event !== "labeled" || !last.actor?.login) return null;
  return { login: last.actor.login, bot: isBot(last.actor), at: Date.parse(last.created_at) || 0 };
}

const isBot = (actor) => actor?.type === "Bot" || lower(actor?.login).endsWith("[bot]");

// Whether `login` (with `actor`'s type, when known) is an allowed user here: in ALLOWED_USERS
// and the repo's `users`, not a bot.
const allowed = (actor, config, users) =>
  !!actor?.login &&
  !isBot(actor) &&
  config.users.includes(lower(actor.login)) &&
  users.includes(lower(actor.login));

// Why the issue's text isn't the one the label vouched for, or null: its title renamed (its
// events) or its description edited (`history`: its edits, as lastEdits() reads them) at or
// after `since`, the label's time (both to the second), by someone who isn't an allowed user
// (the App's bot included: what a run writes may come from anyone's comments). Every edit
// counts, not the last one: an allowed user's typo fix after an outsider's rewrite doesn't
// vouch for it. On a public repo, an outsider's issue edited after it was labelled would
// otherwise run as the labeller's.
export function editedSince(events, history, since, config, users) {
  const after = (at) => Date.parse(at ?? "") >= since;
  const renamed = events.find(
    (e) => e.event === "renamed" && after(e.created_at) && !allowed(e.actor, config, users),
  );
  if (renamed) {
    return `its title was changed by ${renamed.actor?.login ?? "someone"} after the label was added`;
  }
  const edited = history.edits.find((e) => after(e.at) && !allowed(e.editor, config, users));
  if (edited) {
    return `its description was edited by ${edited.editor?.login ?? "someone"} after the label was added`;
  }
  // The newest edit, as the issue itself says, whatever end of its history was read.
  const last = history.last;
  if (last && after(last.at) && !allowed(last.editor, config, users)) {
    return `its description was edited by ${last.editor?.login ?? "someone"} after the label was added`;
  }
  // Not all of it read: GitHub doesn't say in which order it lists them, so the edits not read
  // may be the newest (the page doesn't reach the issue's last edit) or the oldest (every one
  // read is since the label). Either way some may be since the label: not knowing holds it.
  if (!history.complete) {
    const second = (at) => Math.floor(Date.parse(at ?? "") / 1000);
    const reachesLast = !last || history.edits.some((e) => second(e.at) >= second(last.at));
    if ((!reachesLast && after(last.at)) || history.edits.every((e) => after(e.at))) {
      return "its description has more edits since the label than can be checked";
    }
  }
  return null;
}

// The most edits read: GitHub's page.
const EDITS_PAGE = 100;
const EDITS = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { lastEditedAt editor { login __typename } userContentEdits(last: ${EDITS_PAGE}) { pageInfo { hasPreviousPage hasNextPage } nodes { editedAt editor { login __typename } } } } } }`;

// The issue description's edits: { edits: [{ at, editor: { login, type } }], complete, last },
// `complete` false when there are more than those read, on either side (GitHub doesn't
// document their order), and `last` the newest edit as the issue says it ({ at, editor }),
// null when never edited.
async function lastEdits(github, repo, number) {
  const [owner, name] = repo.split("/");
  const data = await graphql(github, repo, EDITS, { owner, name, number });
  const issue = data?.repository?.issue;
  const found = issue?.userContentEdits;
  if (!found) throw new Error(`#${number}: not found to check its edits`);
  const editorOf = (e) => e && { login: e.login, type: e.__typename };
  return {
    last: issue.lastEditedAt ? { at: issue.lastEditedAt, editor: editorOf(issue.editor) } : null,
    edits: (found.nodes ?? []).map((e) => ({
      at: e?.editedAt ?? null,
      editor: editorOf(e?.editor),
    })),
    complete: !found.pageInfo?.hasPreviousPage && !found.pageInfo?.hasNextPage,
  };
}

// Why the person who added the label may not start the run, or null. `users`: the repo's
// (already within ALLOWED_USERS).
export function labellerRefusal(by, config, users) {
  if (by.bot) return `the label was added by a bot (${by.login})`;
  if (!allowed({ login: by.login }, config, users)) {
    return `the label was added by ${by.login}, who isn't an allowed user`;
  }
  return null;
}

// The issue numbers Deckhand's open pull requests are for: those the App opened, from a branch
// of the repo, saying which issue they close, or on its `issue-<n>-…` branch.
export function pulledIssues(pulls, repo, bot) {
  const numbers = new Set();
  for (const pr of pulls) {
    if (!bot || lower(pr.user?.login) !== lower(bot) || !headInRepo(pr, repo)) continue;
    const n = linkedIssue(pr, repo, bot) ?? Number(/^issue-(\d+)-/.exec(pr.head?.ref ?? "")?.[1]);
    if (n) numbers.add(n);
  }
  return numbers;
}

// `github(repo, method, path, body, expected)`: the App's calls. `repos()`: the repos to look
// at, [{ repo, base }], those whose config, as last read, opts in (repos.mjs). `repoSettings`:
// the default branch's config, read again before a start. `accept(item)`: queues it
// (tasks.mjs), → its mode or null. `reply(repo, number, text)`: the App's comment.
// `live()`: a predicate of task keys, whether the task has something live (the dashboard's
// tasks, or a run going or queued), as things are now: it rebuilds the dashboard's tasks, so
// a sweep builds one for all its candidates, and start() another right before its comment. `taken()`: how many reserved slots auto-picked tasks hold, running or queued
// (tasks.mjs pickedCount()). `load(repo)`: how many of the repo's tasks are running or queued
// (tasks.mjs repoLoad()).
export function createAutoPickup({
  config,
  github,
  repos,
  repoSettings,
  accept,
  reply,
  live,
  taken,
  load = () => 0,
  log = () => {},
  every = (fn, ms) => setInterval(fn, ms),
  later = (fn, ms) => setTimeout(fn, ms),
}) {
  const slots = config.autoPickupSlots ?? 0;
  const label = config.autoPickupLabel;
  // One sweep at a time; one asked for meanwhile runs after it.
  let sweeping = null;
  let again = false;
  let timer = null;
  let soonTimer = null;
  // Task key → why it was last skipped: logged when it changes, not at every sweep.
  const skipped = new Map();
  // Task key → { stamp, why, held } of an issue held by its labelling (who added the label, an
  // edit since): checked again only once the issue (its `updated_at`: labels, edits, comments)
  // or the repo's users change, not with its events and edits read at every sweep.
  const holds = new Map();
  // "<key>@<label's time>" of the labellings whose hold the App's comment told already.
  const told = new Set();
  // "<key>@<label's time>" of the labellings whose label couldn't be taken off once picked:
  // not picked again, or each sweep would post another comment while GitHub refuses. A person
  // adding the label again (a new labelling) tries again.
  const stuck = new Set();

  // The free reserved slots, filled with the oldest eligible labelled issues. → the keys
  // started.
  function sweep() {
    if (!slots) return Promise.resolve([]);
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = pick()
      .catch((error) => {
        log(`Auto-pickup: ${error.message ?? error}`);
        return [];
      })
      .finally(() => {
        sweeping = null;
        if (again) {
          again = false;
          sweep();
        }
      });
    return sweeping;
  }

  async function pick() {
    let free = slots - taken();
    if (free <= 0) return [];
    const candidates = [];
    // Those whose list couldn't be read this sweep: what is kept of their issues stays.
    const unread = new Set();
    for (const { repo, base } of await repos()) {
      try {
        for (const issue of await labelled(repo)) candidates.push({ repo, base, issue });
      } catch (error) {
        unread.add(repo.toLowerCase());
        log(`Auto-pickup: ${repo}: ${error.message ?? error}`);
      }
    }
    // Oldest created first, across the repos.
    candidates.sort((a, b) => Date.parse(a.issue.created_at) - Date.parse(b.issue.created_at));
    const pulls = new Map();
    // What is live, once for every candidate.
    const isLive = live();
    // Each repo's settings, read once per sweep.
    const settingsOf = new Map();
    const started = [];
    for (const candidate of candidates) {
      if (free <= 0) break;
      const key = taskKey(candidate.repo, candidate.issue.number);
      try {
        const why = await refusal(candidate, pulls, settingsOf, isLive);
        if (why) {
          if (skipped.get(key) !== why) log(`Auto-pickup: ${key}: skipped, ${why}`);
          skipped.set(key, why);
          if (candidate.held) await tell(candidate, why);
          continue;
        }
        skipped.delete(key);
        if (await start(candidate)) {
          started.push(key);
          free--;
        }
      } catch (error) {
        log(`Auto-pickup: ${key}: ${error.message ?? error}`);
      }
    }
    forget(new Set(candidates.map((c) => taskKey(c.repo, c.issue.number))), unread);
    return started;
  }

  // What is kept of the issues no longer labelled (closed, the label off, their repo gone):
  // dropped, the listener runs for long. Not those of a repo whose list failed this sweep
  // (`unread`): `stuck` has nothing on GitHub to find again, and the failure that kept a label
  // on is likely to fail the list too.
  function forget(keys, unread) {
    const kept = (key) =>
      keys.has(key) || unread.has(key.slice(0, key.lastIndexOf("#")).toLowerCase());
    const labelling = (entry) => entry.slice(0, entry.lastIndexOf("@"));
    for (const map of [skipped, holds]) for (const key of map.keys()) kept(key) || map.delete(key);
    for (const set of [told, stuck])
      for (const entry of set) kept(labelling(entry)) || set.delete(entry);
  }

  // The repo's open issues with the label (pull requests are issues to this API: left out).
  async function labelled(repo) {
    const path = `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc`;
    const list = await paginate((p) => github(repo, "GET", p), path);
    return list.filter((i) => !i.pull_request && i.state === "open");
  }

  // Why the candidate isn't picked now, or null. The cheap checks first; `pulls`: each repo's
  // Deckhand pull requests, `settingsOf` its settings, read once per sweep. Leaves
  // `candidate.by` and `candidate.settings` for start(), or `candidate.held` ({ at }: the
  // label's time) when its labelling holds it.
  async function refusal(candidate, pulls, settingsOf, isLive) {
    const { repo, base, issue } = candidate;
    const n = issue.number;
    const key = taskKey(repo, n);
    if (config.needsInputLabel && hasLabel(issue.labels, config.needsInputLabel)) {
      return `it has open questions (${config.needsInputLabel})`;
    }
    if (isLive(key)) return "something is live on it";
    if (!pulls.has(repo)) {
      const open = await paginate((p) => github(repo, "GET", p), `/repos/${repo}/pulls?state=open`);
      pulls.set(repo, pulledIssues(open, repo, config.bot));
    }
    if (pulls.get(repo).has(n)) return "Deckhand has an open pull request for it";
    if (await blocked(repo, issue)) return "an open issue blocks it";
    if (!settingsOf.has(repo)) settingsOf.set(repo, await repoSettings(repo, base));
    const { settings, errors } = settingsOf.get(repo);
    if (errors.length) return `${CONFIG_FILE} has errors`;
    if (!settings.autoPickup) return `${CONFIG_FILE} no longer has auto_pickup`;
    // Picked now, it would wait for its repo while holding a reserved slot. Without a cap of
    // its own below MAX_PARALLEL, it waits for a slot as any other.
    const cap = settings.maxParallel ?? config.maxParallel;
    if (cap < config.maxParallel && load(repo) >= cap) {
      return "its repository's runs are at its max_parallel";
    }
    const stamp = `${issue.updated_at}|${settings.users.join(",")}`;
    const known = holds.get(key);
    if (known?.stamp === stamp) {
      candidate.held = known.held;
      return known.why;
    }
    holds.delete(key);
    const events = await paginate(
      (p) => github(repo, "GET", p),
      `/repos/${repo}/issues/${n}/events`,
    );
    const by = labeller(events, label);
    // Its latest labelling not in its events yet: not held (nor told), read again next sweep.
    if (!by) return "who added the label isn't in its events yet";
    let why = labellerRefusal(by, config, settings.users);
    if (!why) {
      const edited = editedSince(
        events,
        await lastEdits(github, repo, n),
        by.at,
        config,
        settings.users,
      );
      if (edited) why = edited;
    }
    if (why) {
      candidate.held = { at: by?.at ?? 0 };
      holds.set(key, { stamp, why, held: candidate.held });
      return why;
    }
    if (stuck.has(`${key}@${by.at}`)) {
      return "its label couldn't be taken off when it was picked: take it off and add it again to retry";
    }
    candidate.by = by.login;
    candidate.at = by.at;
    candidate.settings = settings;
    return null;
  }

  // The App's comment, once per labelling, on an issue its labelling holds: the label stays on
  // it, and only the listener's log would say why. Its marker (with the label's time) keeps a
  // restarted listener from saying it again.
  async function tell({ repo, issue, held }, why) {
    const key = taskKey(repo, issue.number);
    const once = `${key}@${held.at}`;
    if (told.has(once)) return;
    const marker = `<!-- deckhand:auto-pickup-held ${held.at} -->`;
    const path = `/repos/${repo}/issues/${issue.number}/comments`;
    const comments = await paginate((p) => github(repo, "GET", p), path);
    // The App's own only: anyone may post the marker to silence it.
    const mine = (c) => !!config.bot && lower(c.user?.login) === lower(config.bot);
    if (!comments.some((c) => mine(c) && c.body?.includes(marker))) {
      const text = `Not picked automatically: ${why}. The \`${label}\` label stays, but nothing starts until an allowed user adds it again.\n\n${marker}`;
      await reply(repo, issue.number, text);
    }
    told.add(once);
  }

  // Whether an open issue blocks it ("blocked by", as plans.mjs reads them).
  async function blocked(repo, issue) {
    if (issue.issue_dependencies_summary?.total_blocked_by === 0) return false;
    const path = `/repos/${repo}/issues/${issue.number}/dependencies/blocked_by`;
    const blockers = await paginate((p) => github(repo, "GET", p), path);
    return blockers.some((b) => b.state === "open");
  }

  // The App's comment first, then the label off, then the run, as the dashboard's start
  // queues it (work.mjs). A comment refused changes nothing: the next sweep tries again. The
  // label comes off right before the run is queued, so a failed or stopped run isn't picked
  // again and again; what doesn't start (the label gone meanwhile, the policies, an error)
  // says so in the comment, as work.mjs started() does, and a person adds the label back.
  async function start({ repo, base, issue, by, at, settings }) {
    const n = issue.number;
    const key = taskKey(repo, n);
    const text = `Picked automatically: the \`${label}\` label was added by @${by}, who the run is for. The label is off now: add it again to pick this issue once more.`;
    // Started by a person while its checks were read (a comment, the dashboard): theirs alone.
    if (live()(key)) {
      log(`Auto-pickup: ${key}: not picked, it started meanwhile`);
      return false;
    }
    const posted = await (await reply(repo, n, text)).json();
    const path = `/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`;
    const res = await github(repo, "DELETE", path, undefined, [404]).catch((error) => ({
      ok: false,
      status: error.message ?? error,
    }));
    if (!res.ok) {
      // 404: someone took it off since the list was read.
      const gone = res.status === 404;
      if (!gone) stuck.add(`${key}@${at}`);
      await notStarted(
        repo,
        posted.id,
        by,
        gone ? "the label was taken off meanwhile" : "the label couldn't be taken off",
        gone ? undefined : "Take the label off and add it again to retry.",
      );
      if (gone) return false;
      throw new Error(`taking the label off: ${res.status}`);
    }
    const item = issueItem(repo, issue, {
      trigger: "work",
      modeLine: null,
      text: "",
      author: by,
      base,
      settings,
      autoPickup: true,
      comment: { id: posted.id, html_url: posted.html_url, node_id: posted.node_id },
    });
    let mode = null;
    let failed = null;
    try {
      mode = await accept(item);
    } catch (error) {
      failed = error;
    }
    if (!mode) {
      const why = item.refused ? "the policies refuse it" : "it couldn't be queued";
      await notStarted(repo, posted.id, by, why);
    }
    if (failed) throw failed;
    log(
      `Auto-pickup: ${key}: ${mode ? "started" : `not started${item.refused ? ", refused by the policies" : ""}`} (label added by ${by})`,
    );
    return !!mode;
  }

  // The App's comment, edited to say nothing started.
  async function notStarted(repo, id, by, why, retry = "Add the label again to retry.") {
    const body = `Picked automatically (the \`${label}\` label, added by @${by}): not started, ${why}. ${retry}\n\n${MARKER}`;
    const path = `/repos/${repo}/issues/comments/${id}`;
    const res = await github(repo, "PATCH", path, { body }).catch((error) => ({
      ok: false,
      status: error.message ?? error,
    }));
    if (!res.ok) log(`Auto-pickup: editing comment ${id}: ${res.status}`);
  }

  // A sweep soon: a picked run ended, or the label was added.
  function soon() {
    if (!slots || soonTimer) return;
    soonTimer = later(() => {
      soonTimer = null;
      sweep();
    }, SOON_MS);
    soonTimer?.unref?.();
  }

  function startTimer() {
    if (!slots || timer) return;
    sweep();
    timer = every(sweep, SWEEP_MS);
    timer?.unref?.();
  }

  function stop() {
    clearInterval(timer);
    clearTimeout(soonTimer);
    timer = null;
    soonTimer = null;
  }

  return { sweep, soon, start: startTimer, stop, slots, label };
}

// Whether an `issues` delivery added the auto-pickup label: a sweep soon (soon()).
export function labelAdded(config, event, payload) {
  return (
    !!config.autoPickupSlots &&
    event === "issues" &&
    payload?.action === "labeled" &&
    lower(payload.label?.name) === lower(config.autoPickupLabel)
  );
}
