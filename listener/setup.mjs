// /setup: creates the operator's private GitHub App through GitHub's App manifest flow
// (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
// and stores its ID, private key and webhook secret (github-app.mjs, saveCredentials()).
//
//   GET  /setup?token=…   form: the App's name and, optionally, the organization owning it
//   POST /setup           a page whose button posts the manifest to GitHub
//   GET  /setup/callback  GitHub's redirect once the App exists: the code is exchanged for
//                         its credentials, then the browser goes on to install the App
//
// Whoever creates the App decides where webhooks come from, so the form needs the one-time
// token the listener prints in its logs, and the whole flow closes once an App is stored.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { APP_EVENTS, APP_PERMISSIONS } from "./github-app.mjs";

const STATE_TTL_MS = 60 * 60000;

// `publicUrl`: where GitHub reaches this listener.
export function manifest({ name, publicUrl }) {
  return {
    name,
    url: publicUrl,
    hook_attributes: { url: `${publicUrl}/webhook`, active: true },
    redirect_url: `${publicUrl}/setup/callback`,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function same(a, b) {
  const digest = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function page(res, status, title, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)} · Deckhand</title>
    <style>
      :root { color-scheme: light dark; --line: #d6d3d1; --accent: #c2410c; --muted: #78716c; }
      body { font: 15px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
      label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
      input { width: 100%; box-sizing: border-box; padding: 0.5rem; font: inherit; border: 1px solid var(--line); border-radius: 6px; }
      button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; font: inherit; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
      small, .muted { color: var(--muted); }
      small { display: block; margin-top: 0.25rem; }
      .warn { border-left: 3px solid var(--accent); padding-left: 0.75rem; }
      code { font-size: 0.9em; }
    </style>
  </head>
  <body>
    <h1>${escape(title)}</h1>
    ${body}
  </body>
</html>`);
}

// PUBLIC_URL, or what the browser used to get here (through the operator's reverse proxy).
function origin(config, req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers["x-forwarded-proto"] ?? "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0];
  return `${proto}://${host.trim()}`;
}

function publicUrlOf(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on("error", reject);
  });
}

export function createSetup({
  config,
  fetch = globalThis.fetch,
  configured, // () => true once an App is stored
  onConfigured, // (credentials) => stores and starts using them
  random = () => randomBytes(24).toString("hex"),
  now = Date.now,
  log = () => {},
}) {
  const token = random();
  const states = new Map(); // state → { expiry, publicUrl }

  function link() {
    return `${config.publicUrl ?? `http://localhost:${config.port}`}/setup?token=${token}`;
  }

  function done(res) {
    return page(
      res,
      200,
      "Already set up",
      `<p>This listener already has its GitHub App. To install it on more repositories, open the
App's page on GitHub (Settings → Developer settings → GitHub Apps → Install App).</p>
<p class="muted">To start over with a new App, delete <code>app.json</code> from the data volume
and restart the listener.</p>`,
    );
  }

  function refused(res) {
    return page(
      res,
      403,
      "Setup link needed",
      `<p>Open the setup link printed in the listener's logs
(<code>docker compose logs listener</code>): it carries a one-time token.</p>`,
    );
  }

  function form(req, res) {
    const url = origin(config, req);
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url);
    const suggested = `deckhand-${random().slice(0, 6)}`;
    return page(
      res,
      200,
      "Create your GitHub App",
      `<p>Deckhand works through a private GitHub App that you own. GitHub will create it with
the permissions and events Deckhand needs, then send you back here to install it on your
repositories.</p>
<form method="post" action="/setup">
  <input type="hidden" name="token" value="${escape(token)}" />
  <label for="url">Public URL of this listener</label>
  <input id="url" name="url" type="url" required value="${escape(url)}" />
  <small>Where GitHub sends webhooks (<code>/webhook</code>) and screenshots are served.</small>
  ${
    local
      ? `<p class="warn">GitHub cannot reach a local address: use the public address of your
reverse proxy or tunnel.</p>`
      : ""
  }
  <label for="name">App name</label>
  <input id="name" name="name" required maxlength="34" value="${escape(suggested)}" />
  <small>Unique across GitHub, 34 characters at most.</small>
  <label for="org">Organization (optional)</label>
  <input id="org" name="org" placeholder="Leave empty for your personal account" />
  <small>The account that owns the App and its repositories.</small>
  <button type="submit">Continue</button>
</form>`,
    );
  }

  async function submit(req, res) {
    const { token: given = "", name = "", org = "", url = "" } = await readForm(req);
    if (!same(given, token)) return refused(res);
    const app = name.trim();
    const owner = org.trim();
    const publicUrl = publicUrlOf(url.trim());
    if (!app || app.length > 34 || (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) || !publicUrl) {
      return page(
        res,
        400,
        "Check the form",
        `<p>An App name (34 characters at most), an http(s) public URL, and an organization
login made of letters, digits and dashes.</p>`,
      );
    }
    const state = random();
    states.set(state, { expiry: now() + STATE_TTL_MS, publicUrl });
    const target = owner
      ? `${config.githubUrl}/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : `${config.githubUrl}/settings/apps/new`;
    return page(
      res,
      200,
      "Create it on GitHub",
      `<p>GitHub shows the App with its permissions (issues, pull requests, contents,
deployments, discussions; actions and metadata read-only) and its events. Create it there, and you come
back here to install it.</p>
<form method="post" action="${escape(target)}?state=${escape(state)}">
  <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest({ name: app, publicUrl })))}" />
  <button type="submit">Create “${escape(app)}” on GitHub</button>
</form>`,
    );
  }

  async function callback(res, url) {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = states.get(state);
    states.delete(state);
    if (!pending || pending.expiry < now() || !/^[\w-]+$/.test(code)) {
      return page(res, 400, "Setup expired", `<p>Start again from the setup link in the logs.</p>`);
    }
    const res1 = await fetch(`${config.githubApi}/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "deckhand",
      },
    });
    if (!res1.ok) {
      log(`Setup: GitHub refused the manifest code: ${res1.status} ${await res1.text()}`);
      return page(
        res,
        502,
        "GitHub refused",
        `<p>Start again from the setup link in the logs.</p>`,
      );
    }
    const app = await res1.json();
    // The bot's user id makes its commits link to it; GitHub shows them without it anyway.
    let botId = null;
    try {
      const bot = await fetch(
        `${config.githubApi}/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "deckhand",
          },
        },
      );
      if (bot.ok) botId = (await bot.json()).id;
    } catch {
      // Commits then use the bot's name alone.
    }
    const credentials = {
      id: app.id,
      slug: app.slug,
      client_id: app.client_id,
      client_secret: app.client_secret,
      webhook_secret: app.webhook_secret,
      pem: app.pem,
      owner: app.owner?.login ?? null,
      html_url: app.html_url,
      bot_id: botId,
      public_url: pending.publicUrl,
      created_at: new Date(now()).toISOString(),
    };
    onConfigured(credentials);
    log(`Setup: GitHub App ${app.slug} (id ${app.id}) stored`);
    res.writeHead(302, { location: `${app.html_url}/installations/new` });
    res.end();
  }

  // Handles /setup and /setup/callback; false for any other path.
  function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/setup" && url.pathname !== "/setup/callback") return false;
    const run = async () => {
      if (configured()) return done(res);
      if (url.pathname === "/setup/callback") return callback(res, url);
      if (req.method === "POST") return submit(req, res);
      if (req.method !== "GET") return page(res, 405, "Not allowed", "");
      return same(url.searchParams.get("token") ?? "", token) ? form(req, res) : refused(res);
    };
    run().catch((error) => {
      log(`Setup: ${error.stack ?? error}`);
      if (!res.headersSent) page(res, 500, "Setup failed", `<p>See the listener's logs.</p>`);
    });
    return true;
  }

  return { handle, link };
}
