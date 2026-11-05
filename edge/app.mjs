// The App's credentials edge holds (#506): app.json in its data folder, written by /setup. The
// webhook secret and the OAuth client's are edge's to hold; never the App's key, which the
// github service alone has (#502).
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadCredentials, saveCredentials } from "../listener/github-app.mjs";

// What the orchestrator may read of them (GET /app on edge's internal port): the App's names and
// where the dashboard is, nothing secret.
const PUBLIC = ["id", "slug", "owner", "html_url", "bot_id", "public_url"];

export function publicPart(credentials) {
  if (!credentials) return { configured: false };
  return {
    configured: true,
    ...Object.fromEntries(
      PUBLIC.filter((k) => credentials[k] != null).map((k) => [k, credentials[k]]),
    ),
  };
}

// The credentials without the App's key, whoever sent it along.
export function withoutKey(credentials) {
  const { pem: _, ...kept } = credentials ?? {};
  return kept;
}

// What tells app.json's writes apart: saveCredentials() renames a new file in.
function signature(path) {
  try {
    const { ino, size, mtimeMs } = statSync(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch {
    return null;
  }
}

export function createEdgeApp({ dir }) {
  const path = join(dir, "app.json");
  let held = null;
  let seen;
  // Read again once another copy of edge wrote it (its /setup), on one volume.
  function read() {
    const now = signature(path);
    if (now === seen) return held;
    seen = now;
    held = now ? loadCredentials(dir) : null;
    // A copy from before the github service would still hold the key: kept out of memory, and
    // out of the file at its next write.
    if (held?.pem) held = withoutKey(held);
    return held;
  }
  read();

  function save(credentials) {
    held = withoutKey(credentials);
    saveCredentials(dir, held);
    seen = signature(path);
  }

  return {
    get: read,
    save,
    info: () => publicPart(read()),
    // The secrets edge holds of them: kept out of its store (lib/store.mjs).
    secrets: () => [read()?.webhook_secret, read()?.client_secret].filter(Boolean),
  };
}
