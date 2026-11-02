// The GitHub App as the github service holds it (#502): its credentials, the private key with
// them, in APP_DIR/app.json, the service's own volume (or Secret), never the store nor another
// service's. They come either from /setup's manifest conversion, which the service makes itself
// (convert(): the key never leaves it, the listener gets the rest), or from a listener that held
// them before this service (handOver(), once: the listener then removes its key).
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../lib/files.mjs";
import { createGitHubApp, GITHUB_HEADERS, saveCredentials } from "../listener/github-app.mjs";

// What the service keeps of the App: what it signs its JWT and names its bot with. The webhook
// secret and the OAuth client's are edge's (the listener's): not kept here.
// How long a conversion's answer is kept for the listener to ask again.
const SETUP_KEPT_MS = 60 * 60_000;

export const KEPT = ["id", "slug", "client_id", "pem", "owner", "html_url", "bot_id", "created_at"];
export const kept = (credentials) =>
  Object.fromEntries(KEPT.filter((k) => credentials[k] != null).map((k) => [k, credentials[k]]));

export function createAppHolder({
  dir,
  api = "https://api.github.com",
  fetch = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  log = () => {},
}) {
  const file = join(dir, "app.json");
  // /setup's last conversion, for a listener that didn't get its answer (convert()).
  const setupFile = join(dir, "setup.json");
  const codeHash = (code) => createHash("sha256").update(code).digest("hex");
  // The edge's secrets it holds go once the listener had its time to ask again: at start, at
  // each conversion, and when that time is over (a timer, armed while the file is there).
  function sweep() {
    const kept = readJson(setupFile);
    if (!kept) return;
    const left = SETUP_KEPT_MS - (now() - kept.at);
    if (!(left > 0)) return rmSync(setupFile, { force: true });
    setTimer(sweep, left + 1000).unref?.();
  }
  sweep();
  let app = null;
  function use(credentials) {
    app = credentials?.pem ? createGitHubApp({ credentials, api, fetch, now, log }) : null;
  }
  use(readJson(file));

  function save(credentials) {
    saveCredentials(dir, kept(credentials));
    use(readJson(file));
  }

  // The public parts, for the listener and the dashboard.
  function info() {
    if (!app) return { configured: false };
    const { id, slug, client_id, owner, html_url, bot_id } = app.credentials;
    return { configured: true, id, slug, client_id, owner, html_url, bot_id, ...app.identity() };
  }

  // A listener's App from before this service: taken when the service has none, or the same
  // App's (its key replaced). → { status, message } when refused, else null.
  function handOver(credentials) {
    if (!credentials?.pem || !credentials.id) return { status: 400, message: "no App's key" };
    const held = app?.credentials;
    if (held && String(held.id) !== String(credentials.id)) {
      return { status: 409, message: `the github service holds another App (id ${held.id})` };
    }
    save(credentials);
    log(`GitHub App ${credentials.slug ?? credentials.id}: its key handed over by the listener`);
    return null;
  }

  // /setup's manifest code → the App's credentials but its key, which only this service keeps.
  // → { status, message } when GitHub refused it, or the service has an App already.
  async function convert(code) {
    if (typeof code !== "string" || !/^[\w-]+$/.test(code)) {
      return { status: 400, message: "not a manifest code" };
    }
    // The same code again: its answer was lost on its way to the listener, which reloads the
    // page. GitHub converts a code once: what the listener needs of it is kept a while here,
    // the service's own volume, the key apart.
    sweep();
    const kept = readJson(setupFile);
    if (app && kept?.code === codeHash(code) && now() - kept.at < SETUP_KEPT_MS) {
      return { credentials: kept.credentials };
    }
    if (app) return { status: 409, message: "the github service holds an App already" };
    const credentials = await convertManifest({ code, api, fetch, now, log });
    if (credentials.status) return credentials;
    const { pem: _, ...rest } = credentials;
    writeJsonAtomic(
      setupFile,
      { code: codeHash(code), at: now(), credentials: rest },
      { mode: 0o600 },
    );
    save(credentials);
    sweep();
    log(`Setup: GitHub App ${credentials.slug} (id ${credentials.id}) stored`);
    return { credentials: rest };
  }

  return { get: () => app, info, handOver, convert };
}

// GitHub's answer to /setup's manifest code → the App's credentials, its key and edge's secrets
// with them, as /setup stores them (convert() here; deploy/kubernetes/secrets.mjs on an
// operator's machine). → { status, message } when GitHub refused the code.
export async function convertManifest({
  code,
  api = "https://api.github.com",
  fetch = globalThis.fetch,
  now = Date.now,
  log = () => {},
}) {
  const res = await fetch(`${api}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: GITHUB_HEADERS,
  });
  if (!res.ok) {
    log(`Setup: GitHub refused the manifest code: ${res.status} ${await res.text()}`);
    return { status: 502, message: `GitHub refused the manifest code: ${res.status}` };
  }
  const made = await res.json();
  // The bot's user id makes its commits link to it; GitHub shows them without it anyway.
  let botId = null;
  try {
    const bot = await fetch(`${api}/users/${encodeURIComponent(`${made.slug}[bot]`)}`, {
      headers: GITHUB_HEADERS,
    });
    if (bot.ok) botId = (await bot.json()).id;
  } catch {
    // Commits then use the bot's name alone.
  }
  return {
    id: made.id,
    slug: made.slug,
    client_id: made.client_id,
    client_secret: made.client_secret,
    webhook_secret: made.webhook_secret,
    pem: made.pem,
    owner: made.owner?.login ?? null,
    html_url: made.html_url,
    bot_id: botId,
    created_at: new Date(now()).toISOString(),
  };
}
