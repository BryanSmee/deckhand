// Files the egress proxy keeps (cache.mjs, authority.mjs) are written to a temporary one in
// the same folder and renamed into place: a crash or a full disk never leaves half a file
// under the real name (the cache's load() removes the `tmp-` ones a crash left in its folder).
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// A new temporary path in `dir`: `tmp-<random>`, then `-<name>` when given, to tell them apart.
export const tempPath = (dir, name) =>
  join(dir, `tmp-${randomBytes(8).toString("hex")}${name ? `-${name}` : ""}`);

// Writes `data` to `path` all at once or not at all. `dir`: where the temporary file goes,
// `path`'s folder by default; it must be on the same filesystem. `options`: writeFile()'s.
export async function atomicWrite(path, data, { dir = dirname(path), name, ...options } = {}) {
  const temp = tempPath(dir, name);
  try {
    await writeFile(temp, data, options);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
