// A repo's files at one ref, without git: GitHub's tarball, unpacked into a new temporary
// folder (its top folder stripped). Build contexts and preview hooks start from it, in the
// runner service (../runner/), which downloads it through the github service: it holds no
// GitHub token (#503).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// `download(repo, ref)`: the tarball, as fetch()'s Response (the github service's, the runner's
// tarballs() in ../runner/server.mjs). Resolves with the folder; the caller removes it.
export async function checkout(download, repo, ref, { tmp = tmpdir() } = {}) {
  const res = await download(repo, ref);
  if (!res.ok) throw new Error(`downloading ${repo} at ${ref}: ${res.status}`);
  const dir = mkdtempSync(join(tmp, "deckhand-checkout-"));
  try {
    await untar(Readable.fromWeb(res.body), dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function untar(stream, dir) {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", "-", "--strip-components=1", "-C", dir], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let err = "";
    tar.stderr.on("data", (d) => (err += d));
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim()}`))));
    tar.stdin.on("error", () => {}); // tar failed: its exit code says why
    stream.on("error", reject).pipe(tar.stdin);
  });
}
