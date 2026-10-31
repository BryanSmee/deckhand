// The names of the board's lanes (issue #306). The dashboard groups each chain of waiting
// issues into a lane (connected by `edges`); the listener says, for the issues it knows a name
// for, what that name is and where it comes from:
//   user    a name the maintainer gave the lane on the dashboard (POST …/lane, work.mjs)
//   parent  the title of the parent a plan laid it out under (work.mjs plan()), else of its
//           parent issue on GitHub (asked for the issues on the board, fill())
//   inbox   the repo's ideas or bugs inbox issue: its title
// The dashboard picks one per lane (lanes.ts laneName()), else "#18 and 3 more". A name is
// kept on every issue of the lane named, so it outlasts the issues that get done and stays
// when the lane splits. Kept in lanes.json by lowercase task key: one entry whatever the
// spelling of its repo (spelling.mjs).
import { parseKey, taskKey } from "./events.mjs";
import { getJson } from "./github.mjs";
import { respelled, taskId } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

// The longest name, in characters: a lane's header is one line.
export const MAX_NAME = 60;
// How long an entry of a closed issue, or of one the listener never heard of, is kept after
// it was last set: "Show closed" still shows recent ones in their lane.
const KEEP_MS = 90 * 24 * 3600_000;
// How often an open issue's parent is asked again: sub-issues are attached after the fact.
export const PARENT_MS = 3600_000;

// What a repo's inbox issue is called when its title isn't known yet.
const INBOX_NAMES = { ideas: "Ideas", bugs: "Bug reports" };

// Issue `number`'s parent on GitHub, { key, title } (maybe another repo's), or null.
export async function fetchParent(github, repo, number) {
  const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}/parent`, [404, 410]);
  if (!issue?.number) return null;
  const owner = /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? "")?.[1] ?? repo;
  return { key: taskKey(owner, issue.number), title: issue.title ?? null };
}

// `fetchParent(repo, number)`: as fetchParent() above. `closed(key)`: whether the issue is
// closed, `known(key)`: whether the listener has heard of it (titles.mjs), for forgetting old
// entries and not asking about closed issues again.
export function createLanes({
  path,
  fetchParent = async () => null,
  closed = () => false,
  known = () => true,
  now = Date.now,
  log = () => {},
} = {}) {
  // taskId(key) → { key, name?, namedAt?, plan?, parent?, parentAt?, at }: `key` as last
  // spelled; `name` typed at `namedAt`; `plan`, the number of the issue a plan laid it out
  // under (same repo); `parent`: { key, title } on GitHub, asked at `parentAt`; `at`, when
  // anything was last set.
  const lanes = persistentMap(path);
  let fetching = null;

  function update(key, change) {
    const id = taskId(key);
    const entry = { ...lanes.get(id), ...change, key, at: now() };
    for (const field of ["name", "namedAt", "plan", "parent"])
      if (!entry[field]) delete entry[field];
    if (entry.name || entry.plan || entry.parentAt !== undefined) lanes.set(id, entry);
    else lanes.delete(id);
  }

  // Closed or unknown issues set long ago go, on each write.
  function save() {
    const cutoff = now() - KEEP_MS;
    for (const [id, entry] of lanes) {
      if (entry.at < cutoff && (closed(entry.key) || !known(entry.key))) lanes.delete(id);
    }
    lanes.save();
  }

  // The lane of issues `keys` is called `name` from now on ("": the name is taken off, the
  // lane goes back to its parent's or the fallback).
  function name(keys, name) {
    for (const key of keys) {
      if (lanes.get(taskId(key))?.name === name) continue;
      update(key, { name, namedAt: name ? now() : null });
    }
    save();
  }

  // A plan laid out issues `numbers` of `repo` under `parent`, which is part of the lane too.
  function planned(repo, parent, numbers) {
    for (const n of new Set([parent, ...numbers])) update(taskKey(repo, n), { plan: parent });
    save();
  }

  // Asks GitHub for the parent of each open issue of `keys` not asked within PARENT_MS (a
  // closed one only if never asked), one at a time; calls during a fetch wait for the next.
  function fill(keys) {
    const due = [...new Set(keys)].filter((key) => {
      if (parseKey(key)?.kind !== "issue") return false;
      const asked = lanes.get(taskId(key))?.parentAt;
      return asked === undefined || (!closed(key) && now() - asked >= PARENT_MS);
    });
    if (fetching || !due.length) return fetching;
    fetching = (async () => {
      for (const key of due) {
        const { repo, number } = parseKey(key);
        try {
          update(key, { parent: await fetchParent(repo, number), parentAt: now() });
        } catch (error) {
          log(`Parent of ${key}: ${error.message ?? error}`);
        }
      }
      save();
    })().finally(() => (fetching = null));
    return fetching;
  }

  // The keys of the parents of `keys`, whose titles name their lanes (titles.mjs fill()).
  function parentKeys(keys) {
    return keys.flatMap((key) => {
      const entry = lanes.get(taskId(key));
      if (entry?.plan) return [planKey(key, entry.plan)];
      return entry?.parent ? [entry.parent.key] : [];
    });
  }

  // key → { name, source, at? } for those of `keys` that have a name; `at`: when it was typed.
  // `title(key)`: the issue's title, or null; `inboxes`: [repo, { ideas, bugs }]
  // (repo-settings.mjs inboxes()).
  function labels(keys, { title = () => null, inboxes = [] } = {}) {
    const inbox = new Map();
    for (const [repo, numbers] of inboxes) {
      for (const which of ["ideas", "bugs"]) {
        if (numbers?.[which]) inbox.set(taskId(taskKey(repo, numbers[which])), which);
      }
    }
    const found = {};
    for (const key of keys) {
      const entry = lanes.get(taskId(key));
      const which = inbox.get(taskId(key));
      if (entry?.name) found[key] = { name: entry.name, source: "user", at: entry.namedAt };
      else if (entry?.plan) {
        const parent = planKey(key, entry.plan);
        found[key] = { name: title(parent) ?? `#${entry.plan}`, source: "parent" };
      } else if (entry?.parent) {
        const { key: parent, title: was } = entry.parent;
        const name = title(parent) ?? was ?? `#${parseKey(parent)?.number}`;
        found[key] = { name, source: "parent" };
      } else if (which) found[key] = { name: title(key) ?? INBOX_NAMES[which], source: "inbox" };
    }
    return found;
  }

  // The keys as spelled, and the same with one spelling per repo (spelling.mjs, at a restart):
  // titles.mjs's keys are, and the pruning asks it with them.
  const keys = () => [...lanes.values()].map((entry) => entry.key);
  function respell(spelled) {
    let changed = false;
    for (const entry of lanes.values()) {
      const key = respelled(entry.key, spelled);
      const parent = entry.parent && respelled(entry.parent.key, spelled);
      if (key === entry.key && parent === entry.parent?.key) continue;
      entry.key = key;
      if (entry.parent) entry.parent = { ...entry.parent, key: parent };
      changed = true;
    }
    if (changed) lanes.save();
  }

  return {
    name,
    planned,
    fill,
    parentKeys,
    labels,
    keys,
    respell,
    get: (key) => lanes.get(taskId(key)) ?? null,
  };
}

// The key of issue `number` of `key`'s repo.
function planKey(key, number) {
  return `${key.slice(0, key.lastIndexOf("#"))}#${number}`;
}

// A lane name as the dashboard sends it: one line, trimmed, at most MAX_NAME characters; ""
// takes the name off. Null when it isn't one.
export function laneName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}
