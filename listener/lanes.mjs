// The names of the board's lanes (issue #306). The dashboard groups each chain of waiting
// issues into a lane (connected by `edges`); the listener says, for the issues it knows a name
// for, what that name is and where it comes from:
//   user    a name the maintainer gave the lane on the dashboard (POST …/lane, work.mjs)
//   parent  the parent issue a plan laid it out under (work.mjs plan()): the parent's title
//   inbox   the repo's ideas or bugs inbox issue: its title
// The dashboard picks one per lane (lanes.ts laneName()), else "#18 and 3 more". A name is
// kept on every issue of the lane named, so it outlasts the issues that get done and stays
// when the lane splits. Kept in lanes.json by lowercase task key: one entry whatever the
// spelling of its repo (spelling.mjs).
import { taskKey } from "./events.mjs";
import { taskId } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

// The longest name, in characters: a lane's header is one line.
export const MAX_NAME = 60;
// How long an entry of a closed issue is kept after it was last set: "Show closed" still
// shows recent ones in their lane.
const KEEP_MS = 90 * 24 * 3600_000;

// What a repo's inbox issue is called when its title isn't known yet.
const INBOX_NAMES = { ideas: "Ideas", bugs: "Bug reports" };

// `closed(key)`: whether the issue is closed (titles.mjs), for forgetting old entries.
export function createLanes({ path, closed = () => false, now = Date.now } = {}) {
  // taskId(key) → { key, name?, parent?, at }: `key` as last spelled; `parent`, the number of
  // the issue a plan laid it out under (same repo); `at`, when either was last set.
  const lanes = persistentMap(path);

  function update(key, change) {
    const id = taskId(key);
    const entry = { ...lanes.get(id), ...change, key, at: now() };
    if (!entry.name) delete entry.name;
    if (!entry.parent) delete entry.parent;
    if (entry.name || entry.parent) lanes.set(id, entry);
    else lanes.delete(id);
  }

  // Closed issues set long ago go, on each write.
  function save() {
    const cutoff = now() - KEEP_MS;
    for (const [id, entry] of lanes) if (entry.at < cutoff && closed(entry.key)) lanes.delete(id);
    lanes.save();
  }

  // The lane of issues `keys` is called `name` from now on ("": the name is taken off, the
  // lane goes back to its parent's or the fallback).
  function name(keys, name) {
    for (const key of keys) update(key, { name });
    save();
  }

  // A plan laid out issues `numbers` of `repo` under `parent`, which is part of the lane too.
  function planned(repo, parent, numbers) {
    for (const n of new Set([parent, ...numbers])) update(taskKey(repo, n), { parent });
    save();
  }

  // The parents' keys of `keys`, whose titles name their lanes (titles.mjs fill()).
  function parentKeys(keys) {
    return keys.flatMap((key) => {
      const parent = lanes.get(taskId(key))?.parent;
      return parent ? [parentKey(key, parent)] : [];
    });
  }

  // key → { name, source, at? } for those of `keys` that have a name. `title(key)`: the
  // issue's title, or null; `inboxes`: [repo, { ideas, bugs }] (repo-settings.mjs inboxes()).
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
      if (entry?.name) found[key] = { name: entry.name, source: "user", at: entry.at };
      else if (entry?.parent) {
        const parent = parentKey(key, entry.parent);
        found[key] = { name: title(parent) ?? `#${entry.parent}`, source: "parent" };
      } else if (which) found[key] = { name: title(key) ?? INBOX_NAMES[which], source: "inbox" };
    }
    return found;
  }

  return { name, planned, parentKeys, labels, get: (key) => lanes.get(taskId(key)) ?? null };
}

// The key of issue `parent` of `key`'s repo.
function parentKey(key, parent) {
  return `${key.slice(0, key.lastIndexOf("#"))}#${parent}`;
}

// A lane name as the dashboard sends it: one line, trimmed, at most MAX_NAME characters; ""
// takes the name off. Null when it isn't one.
export function laneName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}
