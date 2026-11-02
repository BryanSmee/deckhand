// The App's credentials edge holds (#506): app.json in its data folder, written by /setup or
// handed over by the orchestrator from a listener's data volume. The webhook secret and the OAuth
// client's are edge's to hold; never the App's key, which the github service alone has (#502).
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

// The same credentials, whatever their keys' order.
const sorted = (o) =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
const same = (a, b) => sorted(a) === sorted(b);

// What tells app.json's writes apart: saveCredentials() renames a new file in.
function signature(path) {
  try {
    const { ino, size, mtimeMs } = statSync(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch {
    return null;
  }
}

export function createEdgeApp({ dir, log = () => {} }) {
  const path = join(dir, "app.json");
  let held = null;
  let seen;
  // Read again once another copy of edge wrote it (its /setup, a handover), on one volume.
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

  // A listener's App, from the orchestrator that has its data volume: taken when edge has none
  // yet, or the same App's (asked again after a lost answer). → { status, message } when
  // refused, else null.
  function refusal(credentials) {
    const held = read();
    if (!credentials?.id || !credentials.webhook_secret) {
      return { status: 400, message: "no App's credentials" };
    }
    if (held && String(held.id) !== String(credentials.id)) {
      return { status: 409, message: `edge holds another App (id ${held.id})` };
    }
    // Held already: the same, asked again after a lost answer, and nothing replaced. The
    // orchestrator never changes edge's secrets (its webhook secret, its OAuth client's).
    if (held) {
      return same(held, withoutKey(credentials))
        ? null
        : { status: 409, message: `edge holds App ${held.id} with other credentials` };
    }
    return null;
  }
  function takeOver(credentials) {
    const refused = refusal(credentials);
    if (refused || read()) return refused;
    log(`GitHub App ${credentials.slug ?? credentials.id}: handed over by the orchestrator`);
    save(credentials);
    return null;
  }

  return {
    get: read,
    save,
    takeOver,
    // What takeOver() would say, taking nothing.
    refusal,
    info: () => publicPart(read()),
    // The secrets edge holds of them: kept out of its store (lib/store.mjs).
    secrets: () => [read()?.webhook_secret, read()?.client_secret].filter(Boolean),
  };
}
