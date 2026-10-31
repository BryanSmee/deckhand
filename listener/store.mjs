// The listener's JSON state files (queue, live runs, brainstorms, modes, titles, pull
// requests, onboarding, the App's credentials), read and written the same way.
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

// The file's value, or `fallback` when it is missing or unreadable.
export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Written whole or not at all: a crash mid-write leaves the previous file, never half of one.
// The temporary name is per process, so two writers never share it. `mode`: for secrets.
export function writeJsonAtomic(path, value, { mode } = {}) {
  writeFileAtomic(path, JSON.stringify(value, null, 2), { mode });
}

// Text written whole or not at all, as writeJsonAtomic() (the broker's signing key, say).
export function writeFileAtomic(path, text, { mode } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, mode === undefined ? {} : { mode });
    // writeFileSync's mode only applies to a new file, and the umask narrows it.
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// A Map kept in a JSON file as one object, { key: value }: the listener's state Maps
// (pulls.json, inputs.json, conflicts.json, titles.json, closed.json, waits.json, modes.json).
// `save()` writes it whole; `mode` as writeJsonAtomic()'s. Without a path, nothing is kept.
export function persistentMap(path, { mode } = {}) {
  const map = new Map(path ? Object.entries(readJson(path, {}) ?? {}) : []);
  map.save = () => {
    if (path) writeJsonAtomic(path, Object.fromEntries(map), { mode });
  };
  return map;
}
