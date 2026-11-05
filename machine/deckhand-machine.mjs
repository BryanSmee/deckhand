#!/usr/bin/env node
// deckhand-machine (#599): the driver that runs Deckhand's tasks on your own machine. One file,
// no dependency, Node 20 or later, on Windows, macOS and Linux. It is an MCP client of your
// Deckhand's /mcp, signed in as you with the `deckhand:machine` scope (#481), and runs your own
// Claude Code there:
//
//   deckhand-machine login <url>   signs in (a browser page), after the warning below
//   deckhand-machine run           registers the machine, says it is there and claims its tasks
//
// A claim (listener/claims.mjs) gives a task's work: its repository is fetched into
// <workspace>/<owner>/<repo>/issue-<n>, kept between runs, on the issue's branch; Claude Code runs
// there headless (`claude -p`, stream-json in and out, `--resume` when the issue has a session
// on this machine), its lines sent to post_events, the comments that reach the run (next_message)
// written to its input. Then the branch is pushed with your own git, and finish ends the run.
//
// Deckhand enforces nothing here. The driver writes, per run, settings it suggests to Claude Code
// (settingsFor(): the run's folder writable, the usual credential stores unreadable, the
// repository's granted hosts as its sandbox's network, its sandbox on where Claude Code has one,
// never bypassPermissions), passed with --settings, and tells Deckhand how the run runs (claim's
// `sandbox`, `permissionMode`, `suggestedSettings`, `agentVersion`), which the run's record and
// reply say as the machine reports it. Your machine.yaml (readConfig()) decides the rest.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { posix, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The driver's version, which register_machine and heartbeat report.
export const VERSION = "0.1.0";
// The run tools' protocol it speaks (listener/claims.mjs MACHINE_PROTOCOL).
export const PROTOCOL = 1;
// The Claude Code version settingsFor()'s keys were checked against: the settings say it.
export const CHECKED_WITH = "2.1.300";
export const SCOPE = "deckhand:machine";
// Held the same as listener/machines.mjs's by test/machine-driver.test.mjs.
export const WARNING =
  "An agent will run on this machine on its own, with your files, credentials and network. Deckhand suggests settings for it and enforces none: what it may do there is up to you.";
// Where Claude Code has a sandbox (macOS, Linux and WSL2, which Node sees as Linux).
export const SANDBOXED = new Set(["darwin", "linux"]);
// A post_events call: 1000 lines and 1 MB at most (listener/mcp.mjs); a little under, for the
// JSON around them.
const MAX_LINES = 1000;
const MAX_BATCH = 900 * 1024;
const MAX_LINE = 512 * 1024;
const RETRY_MS = 3000;

const pathsOf = (platform) => (platform === "win32" ? win32 : posix);

// --- machine.yaml ----------------------------------------------------------------------------

// The part of YAML a machine.yaml needs: block mappings and sequences (of scalars or mappings),
// one-line flow sequences, quoted and plain scalars, comments. Anything else is an error.
export function parseYaml(text) {
  const lines = [];
  String(text)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const body = uncomment(raw).trimEnd();
      if (!body.trim()) return;
      if (/^ *\t/.test(body)) throw new Error(`line ${i + 1}: indent with spaces, not tabs`);
      lines.push({ indent: body.length - body.trimStart().length, text: body.trim(), n: i + 1 });
    });
  let at = 0;
  const isItem = (text) => text === "-" || text.startsWith("- ");
  const node = (indent) => (isItem(lines[at].text) ? seq(indent) : map(indent));
  // What follows a "key:" or a "-" alone: a deeper block, or a sequence at the key's own indent.
  const nested = (indent, sameIndentSeq) => {
    const next = lines[at];
    if (next && next.indent > indent) return node(next.indent);
    if (next && sameIndentSeq && next.indent === indent && isItem(next.text)) return seq(indent);
    return null;
  };
  function map(indent) {
    const out = {};
    while (at < lines.length && lines[at].indent === indent && !isItem(lines[at].text)) {
      const { text, n } = lines[at];
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^"'[{#][^:]*?)\s*:(?:\s+(.*))?$/.exec(text);
      if (!m) throw new Error(`line ${n}: "key: value" expected`);
      const key = String(scalar(m[1], n));
      if (Object.hasOwn(out, key)) throw new Error(`line ${n}: ${key} given twice`);
      at++;
      out[key] = m[2] ? inline(m[2], n) : nested(indent, true);
    }
    return out;
  }
  function seq(indent) {
    const out = [];
    while (at < lines.length && lines[at].indent === indent && isItem(lines[at].text)) {
      const { text, n } = lines[at];
      const rest = text.slice(1).trimStart();
      if (!rest) {
        at++;
        out.push(nested(indent, false));
      } else if (/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^"'[{#][^:]*?)\s*:(\s|$)/.test(rest)) {
        // "- key: value": a mapping whose first key shares the dash's line.
        lines[at] = { indent: indent + text.length - rest.length, text: rest, n };
        out.push(map(lines[at].indent));
      } else {
        at++;
        out.push(inline(rest, n));
      }
    }
    return out;
  }
  const value = lines.length ? node(lines[0].indent) : {};
  if (at < lines.length) throw new Error(`line ${lines[at].n}: unexpected indentation`);
  return value;
}

// `raw` without its comment: a # at the start or after a space, outside quotes.
function uncomment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function inline(text, n) {
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error(`line ${n}: a list on one line ends with ]`);
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let quote = null;
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const c = inner[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "," || i === inner.length) {
        items.push(scalar(inner.slice(start, i).trim(), n));
        start = i + 1;
      }
    }
    return items;
  }
  if (text.startsWith("{") || /^[&*!|>]/.test(text)) {
    throw new Error(`line ${n}: only plain or quoted values and [lists] are read`);
  }
  return scalar(text, n);
}

function scalar(text, n) {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`line ${n}: a "quoted" value with JSON's escapes (\\\\ for \\)`);
    }
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new Error(`line ${n}: an unclosed 'quote'`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (/^(null|~)?$/i.test(text)) return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

// ~ and ~/… (or ~\… on Windows) under `home`; others resolved from `base`, the config's folder.
export function expandPath(value, { home, base, platform = process.platform }) {
  const p = pathsOf(platform);
  const text = String(value);
  if (text === "~") return home;
  if (/^~[\\/]/.test(text)) return p.join(home, ...text.slice(2).split(/[\\/]+/));
  return p.resolve(base, text);
}

// machine.yaml, read and checked: → the driver's config, or throws with every problem.
export function readConfig(text, { home, base, platform = process.platform }) {
  const raw = parseYaml(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("machine.yaml: a mapping of settings is expected");
  }
  const problems = [];
  const known = new Set([
    "name",
    "labels",
    "capacity",
    "repos",
    "workspace",
    "paths",
    "deny",
    "claude",
    "model",
    "effort",
    "permission_mode",
    "sandbox",
    "suggested_settings",
    "git_url",
  ]);
  for (const key of Object.keys(raw)) if (!known.has(key)) problems.push(`${key}: not a setting`);
  const list = (key) => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) {
      problems.push(`${key}: a list of names`);
      return [];
    }
    return v;
  };
  const text1 = (key, fallback = null) => {
    const v = raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string" || !v.trim()) {
      problems.push(`${key}: a text`);
      return fallback;
    }
    return v.trim();
  };
  const flag = (key, fallback) => {
    const v = raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "boolean") problems.push(`${key}: true or false`);
    return v === true;
  };
  const where = { home, base, platform };
  const name = text1("name") ?? (hostname() || null);
  const repos = list("repos").map((r) => r.toLowerCase());
  if (!repos.length) problems.push('repos: the repositories it takes ("owner/name" or "owner/*")');
  const capacity = raw.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) {
    problems.push("capacity: 1 to 16");
  }
  const paths = (Array.isArray(raw.paths) ? raw.paths : raw.paths == null ? [] : null) ?? [];
  if (!Array.isArray(raw.paths) && raw.paths != null) problems.push("paths: a list");
  const extra = paths.flatMap((entry, i) => {
    const item = typeof entry === "string" ? { path: entry } : entry;
    if (!item || typeof item.path !== "string" || !item.path) {
      problems.push(`paths.${i}: { path, write } or a path`);
      return [];
    }
    if (item.write !== undefined && typeof item.write !== "boolean") {
      problems.push(`paths.${i}.write: true or false`);
    }
    return [{ path: expandPath(item.path, where), write: item.write === true }];
  });
  const permissionMode = text1("permission_mode", "acceptEdits");
  // Claude Code's own flag for it, too: a run that skips every check isn't one Deckhand starts.
  if (/^bypass/i.test(permissionMode) || /skip/i.test(permissionMode)) {
    problems.push("permission_mode: never bypassPermissions (an unattended agent asks or refuses)");
  }
  const claude = raw.claude ?? "claude";
  const command = typeof claude === "string" ? [claude] : claude;
  if (!Array.isArray(command) || !command.length || command.some((c) => typeof c !== "string")) {
    problems.push("claude: its command, or a list (the command and its first arguments)");
  }
  const gitUrl = text1("git_url");
  if (gitUrl && !gitUrl.includes("{repo}")) problems.push("git_url: with {repo} in it");
  const config = {
    name,
    labels: list("labels").map((l) => l.toLowerCase()),
    capacity,
    repos,
    workspace: expandPath(text1("workspace", "~/deckhand"), where),
    paths: extra,
    deny: list("deny").map((d) => expandPath(d, where)),
    claude: Array.isArray(command) ? command : ["claude"],
    model: text1("model"),
    effort: text1("effort"),
    permissionMode,
    sandbox: flag("sandbox", true),
    suggestedSettings: flag("suggested_settings", true),
    gitUrl,
  };
  if (!name) problems.push("name: this machine's name");
  if (problems.length) throw new Error(`machine.yaml: ${problems.join("; ")}`);
  return config;
}

// --- The suggested settings ------------------------------------------------------------------

// The usual credential stores and browser profiles, under the home folder, per platform: what the
// suggested settings deny reading. `dir`: a folder (its files too), else a file.
const CREDENTIALS = [
  [".ssh"],
  [".aws"],
  [".azure"],
  [".kube"],
  [".gnupg"],
  [".config", "gh"],
  [".config", "gcloud"],
  [".git-credentials", false],
  [".netrc", false],
  [".npmrc", false],
  [".pypirc", false],
  [".docker", "config.json", false],
  [".claude", ".credentials.json", false],
];
const BY_PLATFORM = {
  darwin: [
    ["Library", "Keychains"],
    ["Library", "Cookies"],
    ["Library", "Safari"],
    ["Library", "Application Support", "Google", "Chrome"],
    ["Library", "Application Support", "Chromium"],
    ["Library", "Application Support", "Firefox"],
    ["Library", "Application Support", "Microsoft Edge"],
    ["Library", "Application Support", "BraveSoftware"],
  ],
  linux: [
    [".config", "google-chrome"],
    [".config", "chromium"],
    [".config", "microsoft-edge"],
    [".config", "BraveSoftware"],
    [".mozilla"],
    [".local", "share", "keyrings"],
  ],
  win32: [
    ["AppData", "Roaming", "GitHub CLI"],
    ["AppData", "Local", "Google", "Chrome", "User Data"],
    ["AppData", "Local", "Chromium", "User Data"],
    ["AppData", "Local", "Microsoft", "Edge", "User Data"],
    ["AppData", "Local", "BraveSoftware"],
    ["AppData", "Roaming", "Mozilla", "Firefox"],
  ],
};

// The credential paths of `platform` under `home`: [{ path, dir }], built with its join().
export function credentialPaths(home, platform = process.platform) {
  const p = pathsOf(platform);
  return [...CREDENTIALS, ...(BY_PLATFORM[platform] ?? BY_PLATFORM.linux)].map((parts) => {
    const dir = parts.at(-1) !== false;
    return { path: p.join(home, ...parts.filter((x) => typeof x === "string")), dir };
  });
}

// `path` as Claude Code's permission rules write it: ~/… under the home folder, //… for another
// absolute path (//c/… for a Windows drive), with forward slashes; `/**` after a folder.
export function rulePath(path, { home, platform = process.platform, dir = true }) {
  const p = pathsOf(platform);
  const rel = p.relative(home, path);
  let rule;
  if (rel === "") rule = "~";
  else if (!rel.startsWith("..") && !p.isAbsolute(rel)) rule = `~/${rel.split(p.sep).join("/")}`;
  else if (platform === "win32") {
    const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(path);
    const rest = drive ? `${drive[1].toLowerCase()}/${drive[2]}` : path.replace(/^[\\/]+/, "");
    rule = `//${rest
      .split(/[\\/]+/)
      .filter(Boolean)
      .join("/")}`;
  } else rule = `/${path}`;
  return dir ? `${rule.replace(/\/+$/, "")}/**` : rule;
}

// The settings suggested for a run (Claude Code's settings.json, checked with CHECKED_WITH):
//   `dir`         the run's clone, its working folder: writable
//   `paths`       machine.yaml's extra paths, [{ path, write }]: reachable, read-only unless write
//   `deny`        machine.yaml's own paths to deny, with the credential stores and `driverHome`
//   `hosts`       the claim's (the repository's granted hosts, GitHub's, the agent's): the only
//                 domains its sandbox reaches
//   `sandbox`     its sandbox on (where Claude Code has one: SANDBOXED), failing rather than
//                 running without it
//   `permissionMode` never bypassPermissions, which the settings turn off too
// Pure: `home` and `platform` are given, the paths built with that platform's join().
export function settingsFor({
  run,
  dir,
  paths = [],
  deny = [],
  hosts = [],
  sandbox = true,
  permissionMode = "acceptEdits",
  home,
  driverHome = null,
  platform = process.platform,
}) {
  const on = sandbox && SANDBOXED.has(platform);
  const denied = [
    ...credentialPaths(home, platform),
    ...deny.map((path) => ({ path, dir: true })),
    ...(driverHome ? [{ path: driverHome, dir: true }] : []),
  ];
  const rule = (path, isDir = true) => rulePath(path, { home, platform, dir: isDir });
  const readOnly = paths.filter((x) => !x.write);
  return {
    deckhand: {
      note: "Suggested by Deckhand's machine driver for this run: advisory, nothing checks it. Passed with --settings, above the repository's own settings, whose deny rules still add up.",
      run,
      checkedWith: `Claude Code ${CHECKED_WITH}`,
    },
    permissions: {
      defaultMode: permissionMode,
      disableBypassPermissionsMode: "disable",
      additionalDirectories: paths.map((x) => x.path),
      deny: [
        ...denied.flatMap((d) => [`Read(${rule(d.path, d.dir)})`, `Edit(${rule(d.path, d.dir)})`]),
        ...readOnly.map((x) => `Edit(${rule(x.path)})`),
      ],
    },
    sandbox: on
      ? {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: {
            allowWrite: [dir, ...paths.filter((x) => x.write).map((x) => x.path)],
            denyRead: denied.map((d) => d.path),
          },
          network: { allowedDomains: [...new Set(hosts.map((h) => String(h).toLowerCase()))] },
        }
      : { enabled: false },
  };
}

// --- Signing in (#481) -----------------------------------------------------------------------

const base64url = (buffer) => buffer.toString("base64url");

// Signs in to Deckhand at `url` with `deckhand:machine`: registers a public client, opens the
// browser on its sign-in page (OAuth 2.1 with PKCE, a loopback redirect), and trades the code
// for tokens. → { url, clientId, tokenEndpoint, revocationEndpoint, accessToken, refreshToken,
// expiresAt }. `open(link)`: shows or opens the page; `fetch` and `now` for the tests.
export async function login(url, { fetch = globalThis.fetch, open, now = Date.now } = {}) {
  const base = String(url).replace(/\/+$/, "");
  const meta = await json(fetch(`${base}/.well-known/oauth-authorization-server`), "its metadata");
  const callback = await loopback();
  try {
    const redirect = `http://127.0.0.1:${callback.port}/callback`;
    const client = await json(
      fetch(meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: `deckhand-machine on ${hostname()}`.slice(0, 80),
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
      "its client registration",
    );
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const link = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      scope: SCOPE,
      state,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource: `${base}/mcp`,
    })) {
      link.searchParams.set(k, v);
    }
    await open(link.href);
    const answer = await callback.code;
    if (answer.get("state") !== state) throw new Error("The sign-in's answer isn't this one's.");
    if (answer.get("error")) {
      throw new Error(`Not signed in: ${answer.get("error_description") ?? answer.get("error")}`);
    }
    const tokens = await json(
      fetch(meta.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: answer.get("code") ?? "",
          redirect_uri: redirect,
          client_id: client.client_id,
          code_verifier: verifier,
          resource: `${base}/mcp`,
        }),
      }),
      "its tokens",
    );
    if (
      !String(tokens.scope ?? "")
        .split(" ")
        .includes(SCOPE)
    ) {
      throw new Error(`Signed in without ${SCOPE}: sign in again and allow it.`);
    }
    return {
      url: base,
      clientId: client.client_id,
      tokenEndpoint: meta.token_endpoint,
      revocationEndpoint: meta.revocation_endpoint ?? null,
      ...tokensOf(tokens, now),
    };
  } finally {
    callback.close();
  }
}

const tokensOf = (t, now) => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: now() + (Number(t.expires_in) || 3600) * 1000,
});

async function json(pending, what) {
  const res = await pending;
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const why = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(`Deckhand refused ${what}: ${why}`);
  }
  return body;
}

// A server on the loopback for the sign-in's redirect: → { port, code (its query), close() }.
function loopback() {
  return new Promise((resolve, reject) => {
    let answer;
    const code = new Promise((r) => (answer = r));
    const server = createServer((req, res) => {
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      if (!req.url.startsWith("/callback")) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        query.get("error")
          ? "Not signed in: back to the terminal."
          : "Signed in: back to the terminal.",
      );
      answer(query);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, code, close: () => server.close() }),
    );
  });
}

// --- /mcp ------------------------------------------------------------------------------------

// A tool's error: Deckhand refused the call (its text says why). Not retried.
export class ToolError extends Error {}

// The tools of /mcp, as `credentials` signs in (login()'s, refreshed when they run out, `save`d
// each time). call(name, args) → the tool's structuredContent; ToolError for its refusal,
// another error for the network or the server (worth another try).
export function mcpClient(
  credentials,
  { fetch = globalThis.fetch, save = () => {}, now = Date.now } = {},
) {
  let creds = credentials;
  let ids = 0;

  async function refresh() {
    const res = await fetch(creds.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        resource: `${creds.url}/mcp`,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) {
      // A refresh token that is refused ends the sign-in: only `login` starts another.
      if (res.status === 400 || res.status === 401) {
        throw new ToolError(
          `Signed out (${body?.error_description ?? body?.error ?? res.status}): run \`deckhand-machine login ${creds.url}\` again.`,
        );
      }
      throw new Error(`Deckhand's token endpoint answered ${res.status}`);
    }
    creds = { ...creds, ...tokensOf(body, now) };
    save(creds);
  }

  async function post(message, again = true) {
    if (creds.expiresAt - now() < 60_000) await refresh();
    const res = await fetch(`${creds.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(message),
    });
    if (res.status === 401 && again) {
      await refresh();
      return post(message, false);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`/mcp answered ${res.status}`);
    if (body.error) throw new ToolError(body.error.message ?? "JSON-RPC error");
    return body.result;
  }

  async function call(name, args) {
    const result = await post({
      jsonrpc: "2.0",
      id: ++ids,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (result?.isError) throw new ToolError(result.content?.[0]?.text ?? `${name} failed`);
    return result?.structuredContent ?? {};
  }

  return { call, credentials: () => creds };
}

// --- The driver ------------------------------------------------------------------------------

// The run loop: registers the machine, says it is there every heartbeatSeconds (its claims'
// leases), claims within its capacity and runs each claim's work. `client`: mcpClient()'s;
// `config`: readConfig()'s; `state`: { sessions } kept by `saveState`; `agentVersion`: the
// version Claude Code says. start() → a promise for when stop() is over.
export function createDriver({
  client,
  config,
  home,
  driverHome,
  state = { sessions: {} },
  saveState = () => {},
  agentVersion = null,
  platform = process.platform,
  log = (line) => console.log(line),
  heartbeatMs = null,
  retryMs = RETRY_MS,
  env = process.env,
}) {
  const runs = new Map(); // run id → its run (startRun())
  let machine = null;
  let beat = null;
  let stopping = false;
  let wakeSlot = () => {};
  const sandbox = config.suggestedSettings ? config.sandbox && SANDBOXED.has(platform) : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // What claim reports of how its runs run (listener/mcp.mjs setupOf()).
  const setup = {
    ...(agentVersion && { agentVersion }),
    ...(sandbox !== null && { sandbox }),
    permissionMode: config.permissionMode,
    suggestedSettings: config.suggestedSettings,
  };

  async function register() {
    const answer = await client.call("register_machine", {
      name: config.name,
      labels: config.labels,
      capacity: config.capacity,
      repos: config.repos,
      version: VERSION,
    });
    machine = answer.machine.id;
    const offered = answer.offered ?? [];
    log(
      `${config.name} registered (${machine}): ${offered.length ? offered.map((o) => o.repo).join(", ") : "no repository offers it its tasks yet"}.`,
    );
    return answer;
  }

  async function heartbeat() {
    const asked = [...runs.keys()];
    const sentAt = Date.now();
    try {
      const answer = await client.call("heartbeat", { machine, runs: asked, version: VERSION });
      const held = new Set((answer.claims ?? []).map((c) => c.run));
      // A claim it no longer lists has ended (cancelled, or its lease ran out): its agent stops.
      // Not one claimed after the heartbeat left, which it couldn't list yet.
      for (const run of runs.values()) {
        if (!held.has(run.id) && run.claimedAt < sentAt)
          run.cancel("Deckhand no longer lists its claim");
      }
    } catch (error) {
      log(`heartbeat: ${error.message}`);
      if (error instanceof ToolError && !stopping) {
        // Removed from the dashboard, or another refusal: registered again, its runs over.
        for (const run of runs.values()) run.cancel("the machine was registered again");
        await register().catch((e) => log(`register_machine: ${e.message}`));
      }
    }
  }

  async function claimLoop() {
    while (!stopping) {
      if (runs.size >= config.capacity) {
        await new Promise((r) => (wakeSlot = r));
        continue;
      }
      let work = null;
      try {
        ({ work } = await client.call("claim", {
          machine,
          agent: "claude",
          ...(config.model && { model: config.model }),
          ...(config.effort && { effort: config.effort }),
          ...setup,
          protocol: PROTOCOL,
        }));
      } catch (error) {
        if (stopping) break;
        log(`claim: ${error.message}`);
        await sleep(retryMs);
        continue;
      }
      if (!work) continue;
      // Claimed as it stopped: given back at once, rather than when its lease runs out.
      if (stopping) {
        await client
          .call("release", { machine, run: work.run })
          .catch((error) => log(`release: ${error.message}`));
        break;
      }
      startRun(work);
    }
  }

  // A claim's work run: its clone, Claude Code, its lines and messages, its push and its end.
  function startRun(work) {
    const run = {
      id: work.run,
      key: work.key,
      claimedAt: Date.now(),
      child: null,
      cancelled: null,
      cancel(why) {
        if (run.cancelled) return;
        run.cancelled = why;
        log(`${work.key}: stopped, ${why}`);
        run.child?.kill();
      },
    };
    runs.set(run.id, run);
    log(
      `${work.key}: claimed (run ${work.run}, ${work.branch}${work.resume ? ", its session goes on" : ""})`,
    );
    run.done = execute(work, run)
      .catch((error) => log(`${work.key}: ${error.stack ?? error}`))
      .finally(() => {
        runs.delete(run.id);
        wakeSlot();
      });
    return run;
  }

  // Calls `name` until Deckhand answers (another try after a network error, none after a refusal),
  // or `run` is stopped.
  async function persist(name, args, run = null) {
    for (;;) {
      if (run?.cancelled) throw new ToolError(`stopped: ${run.cancelled}`);
      try {
        return await client.call(name, args);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        log(`${name}: ${error.message}: trying again`);
        await sleep(retryMs);
      }
    }
  }

  async function execute(work, run) {
    const p = pathsOf(platform);
    const dir = p.join(config.workspace, ...work.repository.split("/"), `issue-${work.issue}`);
    const files = p.join(driverHome, "runs");
    mkdirSync(files, { recursive: true });
    const ids = { machine, run: work.run, protocol: PROTOCOL };
    const end = (outcome, reply = null) =>
      persist("finish", { ...ids, outcome, ...(reply && { reply }) }).catch((e) =>
        log(`${work.key}: finish: ${e.message}`),
      );
    let base;
    try {
      base = await checkout(work, dir);
    } catch (error) {
      if (run.cancelled) return;
      return end(
        "error",
        `${config.name} couldn't get ${work.branch} ready:\n\n${fence(error.message)}`,
      );
    }
    if (run.cancelled) return;

    // Its session: the issue's on this machine when the claim resumes one, else a new one.
    const kept = state.sessions?.[work.key];
    const session = work.resume && kept ? ["--resume", kept] : null;
    const id = session ? kept : randomUUID();
    state.sessions = { ...state.sessions, [work.key]: id };
    saveState(state);
    const promptFile = p.join(files, `${work.run}.prompt.md`);
    writeFileSync(promptFile, work.prompt ?? "");
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      config.permissionMode,
      "--append-system-prompt-file",
      promptFile,
      ...(session ?? ["--session-id", id]),
      ...(config.model ? ["--model", config.model] : []),
      ...(config.effort ? ["--effort", config.effort] : []),
    ];
    if (config.suggestedSettings) {
      const settingsFile = p.join(files, `${work.run}.settings.json`);
      const settings = settingsFor({
        run: work.run,
        dir,
        paths: config.paths,
        deny: config.deny,
        hosts: work.hosts ?? [],
        sandbox: config.sandbox,
        permissionMode: config.permissionMode,
        home,
        driverHome,
        platform,
      });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      args.push("--settings", settingsFile);
    }
    const [command, ...first] = config.claude;
    const child = spawn(command, [...first, ...args], {
      cwd: dir,
      env: { ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    run.child = child;
    if (run.cancelled) child.kill();
    const exited = new Promise((resolve) => {
      child.on("error", (error) => resolve({ code: null, error }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdin.on("error", () => {});
    const input = (text) => {
      if (child.stdin.writable) {
        child.stdin.write(
          JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
        );
      }
    };
    input(work.message ?? "");

    // Its lines, sent in order, in batches; `sent` is how many Deckhand has.
    const lines = [];
    let sent = 0;
    let last = null; // its last result
    let flushing = null;
    const flush = () =>
      (flushing ??= (async () => {
        while (sent < lines.length && !run.cancelled) {
          const batch = batchOf(lines, sent);
          try {
            ({ next: sent } = await persist(
              "post_events",
              { ...ids, lines: batch, from: sent },
              run,
            ));
          } catch (error) {
            run.cancel(`post_events: ${error.message}`);
          }
        }
      })().finally(() => (flushing = null)));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      lines.push(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
      try {
        const event = JSON.parse(line);
        if (event.type === "result") last = event;
      } catch {}
      flush();
    });

    // The comments that reach the run, written to its input as they come; closed, its input ends
    // and Claude Code stops after its answer.
    let over = false;
    (async () => {
      let from = 0;
      while (!over && !run.cancelled) {
        let answer;
        try {
          answer = await client.call("next_message", { ...ids, from });
        } catch (error) {
          if (error instanceof ToolError) return;
          await sleep(retryMs);
          continue;
        }
        if (over) return;
        for (const message of answer.messages ?? []) input(message);
        from = answer.next ?? from;
        if (answer.closed) return child.stdin.end();
      }
    })();

    const exit = await exited;
    over = true;
    while (flushing) await flushing;
    if (run.cancelled) return;
    if (exit.error) {
      return end(
        "error",
        `${config.name} couldn't start Claude Code (${config.claude[0]}): ${exit.error.message}`,
      );
    }
    const ok = exit.code === 0 && last && !last.is_error;
    let pushed = null;
    try {
      pushed = await push(work, dir, base);
    } catch (error) {
      const said = last?.result ?? "";
      return end(
        "error",
        `${said ? `${said}\n\n` : ""}${config.name} couldn't push ${work.branch}:\n\n${fence(error.message)}`,
      );
    }
    if (pushed) log(`${work.key}: pushed ${work.branch}`);
    if (ok) return end("ok");
    return end(
      "error",
      last?.result
        ? null
        : `Claude Code exited with ${exit.code ?? exit.signal} on ${config.name}:\n\n${fence(stderr.trim() || "(nothing on stderr)")}`,
    );
  }

  // The issue's clone, kept between runs, on its branch: fetched, then the branch as it is on
  // GitHub (or here, ahead of it), else a new one from the base. → the base's ref.
  async function checkout(work, dir) {
    const url = config.gitUrl ? config.gitUrl.replaceAll("{repo}", work.repository) : work.cloneUrl;
    if (!existsSync(pathsOf(platform).join(dir, ".git"))) {
      mkdirSync(dir, { recursive: true });
      await git(dir, ["clone", "--quiet", url, "."]);
    } else {
      await git(dir, ["fetch", "--quiet", "--prune", "origin"]);
    }
    const base = work.base ? `origin/${work.base}` : "origin/HEAD";
    const remote = await git(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `origin/${work.branch}`,
    ]).then(
      () => true,
      () => false,
    );
    const local = await git(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${work.branch}`,
    ]).then(
      () => true,
      () => false,
    );
    if (local) {
      await git(dir, ["checkout", "--quiet", work.branch]);
      if (remote)
        await git(dir, ["merge", "--quiet", "--ff-only", `origin/${work.branch}`]).catch(() => {});
    } else {
      await git(dir, [
        "checkout",
        "--quiet",
        "-b",
        work.branch,
        remote ? `origin/${work.branch}` : base,
      ]);
    }
    return base;
  }

  // The branch pushed when it has commits past its base and GitHub's copy of it. → whether it was.
  async function push(work, dir, base) {
    const ahead = async (ref) =>
      Number((await git(dir, ["rev-list", "--count", `${ref}..HEAD`]).catch(() => "1")).trim());
    if (!(await ahead(base))) return false;
    const remote = await git(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `origin/${work.branch}`,
    ]).then(
      () => true,
      () => false,
    );
    if (remote && !(await ahead(`origin/${work.branch}`))) return false;
    await git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${work.branch}`]);
    return true;
  }

  function git(cwd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, env, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err = (err + c).slice(-4000)));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(out)
          : reject(new Error(`git ${args[0]}: ${err.trim() || `exit ${code}`}`)),
      );
    });
  }

  async function start() {
    const answer = await register();
    const every = heartbeatMs ?? (answer.heartbeatSeconds ?? 30) * 1000;
    beat = setInterval(heartbeat, every);
    await claimLoop();
  }

  // Its runs stopped and their claims given back, so that they wait for its next start.
  async function stop() {
    stopping = true;
    clearInterval(beat);
    wakeSlot();
    const going = [...runs.values()];
    for (const run of going) run.cancel("the driver stops");
    await Promise.all(
      going.map(async (run) => {
        await run.done;
        await client
          .call("release", { machine, run: run.id })
          .catch((error) => log(`release: ${error.message}`));
      }),
    );
  }

  return { start, stop, register, heartbeat, runs, machineId: () => machine };
}

// The lines of `lines` from `from` that one post_events call takes.
function batchOf(lines, from) {
  const batch = [];
  let size = 0;
  for (let i = from; i < lines.length && batch.length < MAX_LINES; i++) {
    size += Buffer.byteLength(lines[i]) + 8;
    if (batch.length && size > MAX_BATCH) break;
    batch.push(lines[i]);
  }
  return batch;
}

const fence = (text) => `\`\`\`\n${String(text).replace(/```/g, "ˋˋˋ").slice(-3000)}\n\`\`\``;

// --- The command line ------------------------------------------------------------------------

// Where the driver keeps its files: DECKHAND_MACHINE_HOME, else ~/.deckhand-machine.
export const driverHomeOf = (env = process.env, home = homedir()) =>
  env.DECKHAND_MACHINE_HOME || pathsOf(process.platform).join(home, ".deckhand-machine");

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Written for its owner alone: it holds the sign-in's tokens.
function writeSecret(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

// The warning, until its owner types yes.
async function confirm(ask) {
  console.log(`\nWarning: ${WARNING}\n`);
  const said = await ask('Type "yes" to go on: ');
  if (String(said).trim().toLowerCase() !== "yes") throw new Error("Stopped: nothing was changed.");
}

function question(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => (rl.close(), resolve(a))));
}

function openBrowser(link) {
  console.log(`\nSign in to Deckhand in your browser:\n\n  ${link}\n`);
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", link]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", link]
        : ["xdg-open", link];
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {}
}

function claudeVersion(command) {
  return new Promise((resolve) => {
    const [cmd, ...first] = command;
    let out = "";
    const child = spawn(cmd, [...first, "--version"], { windowsHide: true });
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(/\d+\.\d+\.\d+[\w.+-]*/.exec(out)?.[0] ?? null));
  });
}

const USAGE = `deckhand-machine ${VERSION}: runs your Deckhand's tasks on this machine.

  deckhand-machine login <url>   sign in to your Deckhand (its public URL)
  deckhand-machine run           register this machine and take its tasks (Ctrl-C stops)

Its files: ${"$"}DECKHAND_MACHINE_HOME, else ~/.deckhand-machine: machine.yaml (your settings),
credentials.json (the sign-in), state.json, runs/ (each run's settings and prompt).`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, arg] = argv;
  const home = homedir();
  const dhome = driverHomeOf(env, home);
  const join = pathsOf(process.platform).join;
  const files = {
    config: join(dhome, "machine.yaml"),
    credentials: join(dhome, "credentials.json"),
    state: join(dhome, "state.json"),
  };
  if (command === "login") {
    if (!arg) throw new Error("deckhand-machine login <url>: your Deckhand's public URL.");
    await confirm(question);
    mkdirSync(dhome, { recursive: true });
    const credentials = await login(arg, { open: openBrowser });
    writeSecret(files.credentials, credentials);
    const state = readJson(files.state, {});
    writeFileSync(files.state, JSON.stringify({ ...state, accepted: true }, null, 2) + "\n");
    console.log(
      `Signed in to ${credentials.url}. Next: write ${files.config}, then deckhand-machine run.`,
    );
    return;
  }
  if (command === "run") {
    const credentials = readJson(files.credentials, null);
    if (!credentials) throw new Error("Sign in first: deckhand-machine login <url>.");
    if (!existsSync(files.config))
      throw new Error(`No ${files.config}: see docs/setup.md, Your own machine.`);
    const config = readConfig(readFileSync(files.config, "utf8"), { home, base: dhome });
    const state = { sessions: {}, ...readJson(files.state, {}) };
    const saveState = (s) => writeFileSync(files.state, JSON.stringify(s, null, 2) + "\n");
    if (!state.accepted) {
      await confirm(question);
      state.accepted = true;
      saveState(state);
    }
    const agentVersion = await claudeVersion(config.claude);
    if (!agentVersion)
      console.log(`${config.claude[0]} --version said nothing: is Claude Code installed?`);
    if (config.suggestedSettings && config.sandbox && !SANDBOXED.has(process.platform)) {
      console.log("Claude Code has no sandbox on Windows (WSL2 has): its runs here have none.");
    }
    rmSync(join(dhome, "runs"), { recursive: true, force: true });
    const client = mcpClient(credentials, { save: (c) => writeSecret(files.credentials, c) });
    const driver = createDriver({
      client,
      config,
      home,
      driverHome: dhome,
      state,
      saveState,
      agentVersion,
    });
    let stopping = false;
    process.on("SIGINT", () => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log("Stopping: its runs given back…");
      driver.stop().then(() => process.exit(0));
    });
    await driver.start();
    return;
  }
  if (command === "--version" || command === "version") return console.log(VERSION);
  console.log(USAGE);
  if (command && command !== "help" && command !== "--help") process.exitCode = 2;
}

// Run as a command, not imported (the tests).
const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof ToolError ? error.message : (error.stack ?? error));
    process.exit(1);
  });
}
