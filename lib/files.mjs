// The JSON files still written whole (a live run's state, the App's credentials, a queue kept
// when the store was away), and those a release before left for the store (lib/store-map.mjs).
import { randomBytes } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The file's value, or `fallback` when it is missing or unreadable.
export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// A folder's entries, none when it isn't there: what a release before kept in the
// orchestrator's data volume, which one with no volume doesn't have (#619).
export function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Sets aside a file a release before left that no move can read (restart.mjs moveLive(), a
// run's state; runlog.mjs moveSummaries(), a summary), so no start reads it again: renamed to
// <file>.bad, or <file>.bad.<n> beside one the operator hasn't removed yet, which a rename would
// overwrite. Its name no longer ends in .json, so config.mjs leftInData() names it to the
// operator. A rename that fails throws, the file left where it is. → the new name.
export function setAside(dir, file) {
  const taken = new Set(listDir(dir));
  let name = `${file}.bad`;
  for (let n = 2; taken.has(name); n++) name = `${file}.bad.${n}`;
  renameSync(join(dir, file), join(dir, name));
  return name;
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

// The same, without blocking (blob storage's folder, blobs.mjs), for text or bytes. The temporary
// name is per call too: a process may write the same file twice at once.
export async function writeFileAtomicAsync(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
