// The setup-deckhand plugin (#1031): the marketplace and its skills hold together, and its two
// scripts keep secrets out of what they print. The skills themselves are checked by hand at each
// release (docs/contributing/releases.md, The setup skill).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { needsBash, scriptEnv, tempDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const plugin = join(root, "plugin");
const scripts = join(plugin, "scripts");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

// A skill's front matter: its name and description.
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "front matter");
  return Object.fromEntries(
    m[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
}

test("the marketplace offers the plugin of plugin/", () => {
  const market = json(join(root, ".claude-plugin", "marketplace.json"));
  assert.equal(market.name, "deckhand");
  const [entry] = market.plugins;
  assert.equal(market.plugins.length, 1);
  assert.equal(entry.source, "./plugin");
  const manifest = json(join(plugin, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, entry.name);
  // No version: Claude Code then versions it by commit, so a tag pins it and main moves it.
  assert.equal(manifest.version, undefined);
});

test("every step skill is named after its folder and run by setup-deckhand", () => {
  const skills = readdirSync(join(plugin, "skills"));
  const setup = readFileSync(join(plugin, "skills", "setup-deckhand", "SKILL.md"), "utf8");
  for (const name of skills) {
    const text = readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8");
    const meta = frontMatter(text);
    assert.equal(meta.name, name);
    assert.ok(meta.description.length > 40, `${name}: a description`);
    if (name !== "setup-deckhand") assert.match(setup, new RegExp(`\`${name}\``), name);
    // The helpers through the skill's own folder, which Claude Code expands.
    for (const [, script] of text.matchAll(/scripts\/(deckhand-[a-z-]+)/g)) {
      assert.ok(existsSync(join(scripts, script)), `${name}: ${script}`);
    }
    // The docs pages they rely on exist (their anchors: docs-links.test.mjs).
    for (const [, page] of text.matchAll(/`(docs\/[\w/.-]+\.md)/g)) {
      assert.ok(existsSync(join(root, page)), `${name}: ${page}`);
    }
  }
});

// deckhand-env with `args`, on `dir`'s .env, without a terminal.
function env(t, dir, ...args) {
  return spawnSync("sh", [join(scripts, "deckhand-env"), ...args], {
    env: scriptEnv(t, { DECKHAND_DIR: dir }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test(
  "deckhand-env check says set or empty as compose reads .env, never the value",
  { skip: needsBash },
  (t) => {
    const dir = tempDir(t);
    writeFileSync(
      join(dir, ".env"),
      [
        "A=",
        "B=sk-secret-b",
        'C=""',
        "export D = sk-secret-d # a comment",
        "B=",
        "E=sk-secret-e",
      ].join("\n"),
    );
    const { status, stdout } = env(t, dir, "check", "A", "B", "C", "D", "E", "F");
    assert.equal(status, 0);
    assert.equal(stdout, "A empty\nB empty\nC empty\nD set\nE set\nF empty\n");
    assert.doesNotMatch(stdout, /secret/);
    assert.equal(env(t, dir, "check", "BAD-NAME").status, 2);
  },
);

test(
  "deckhand-env set refuses without a terminal and leaves .env as it was",
  { skip: needsBash },
  (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, ".env"), "A=\n");
    const { status, stderr } = env(t, dir, "set", "A");
    assert.equal(status, 1);
    assert.match(stderr, /needs a terminal/);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "A=\n");
  },
);

const token = "0123456789abcdef0123456789abcdef0123456789abcdef";

// deckhand-open-setup on a system of `uname`'s, its kernel's release `osrelease`, with `extra`
// in its environment and `openers` on PATH, fakes that record what they were asked to open: no
// test ever opens a real browser. → what it said, and what each opener got.
function openSetup(
  t,
  {
    url = "https://deckhand.example.com/",
    uname = "Linux",
    osrelease = "6.1.0-generic",
    extra = {},
    openers = [],
  } = {},
) {
  const dir = tempDir(t);
  const bin = tempDir(t);
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // `compose logs edge`: the link of an older start, then the running one's.
  fake(
    "docker",
    `echo "edge-1  | No GitHub App yet. Set it up at http://localhost:8080/setup?token=old"\n` +
      `echo "No GitHub App yet. Set it up at http://localhost:8080/setup?token=${token}"`,
  );
  fake("uname", `echo ${uname}`);
  for (const name of openers) fake(name, `printf '%s\\n' "$1" >> "${join(bin, `${name}.got`)}"`);
  writeFileSync(join(dir, "osrelease"), `${osrelease}\n`);
  const run = spawnSync("sh", [join(scripts, "deckhand-open-setup"), url], {
    env: scriptEnv(t, {
      DECKHAND_DIR: dir,
      DECKHAND_OSRELEASE: join(dir, "osrelease"),
      PATH: `${bin}:/usr/bin:/bin`,
      ...extra,
    }),
    encoding: "utf8",
  });
  const got = Object.fromEntries(
    openers.map((name) => {
      const file = join(bin, `${name}.got`);
      return [name, existsSync(file) ? readFileSync(file, "utf8") : ""];
    }),
  );
  return { status: run.status, said: run.stdout + run.stderr, got };
}

const link = `https://deckhand.example.com/setup?token=${token}\n`;

test(
  "deckhand-open-setup opens the running edge's link behind the public address, never printing it",
  { skip: needsBash },
  (t) => {
    const cases = [
      { name: "Linux with a display", opener: "xdg-open", extra: { DISPLAY: ":0" } },
      { name: "macOS", opener: "open", uname: "Darwin" },
      { name: "WSL2", opener: "wslview", osrelease: "5.15.167.4-microsoft-standard-WSL2" },
    ];
    for (const { name, opener, ...system } of cases) {
      const { status, said, got } = openSetup(t, {
        ...system,
        openers: ["xdg-open", "open", "wslview"],
      });
      assert.equal(status, 0, name);
      assert.equal(got[opener], link, name);
      for (const other of Object.keys(got))
        if (other !== opener) assert.equal(got[other], "", name);
      assert.doesNotMatch(said, /token=(old|[0-9a-f])/, name);
      assert.match(said, /Opened the setup page \(https:\/\/deckhand\.example\.com\/setup\)/, name);
    }
  },
);

test(
  "deckhand-open-setup in pull mode: a local http:// address, never a public one (#1032)",
  { skip: needsBash },
  (t) => {
    for (const url of ["http://localhost:8080", "http://192.168.1.20:8080/", "http://nas.local"]) {
      const { status, said, got } = openSetup(t, {
        url,
        extra: { DISPLAY: ":0" },
        openers: ["xdg-open"],
      });
      assert.equal(status, 0, url);
      assert.equal(got["xdg-open"], `${url.replace(/\/$/, "")}/setup?token=${token}\n`, url);
      assert.doesNotMatch(said, /token=/, url);
    }
    for (const url of ["http://10.example.com", "http://172.32.0.1"]) {
      const { status, said } = openSetup(t, { url });
      assert.equal(status, 2, url);
      assert.match(said, /http:\/\/ only for a local address/, url);
    }
  },
);

test(
  "deckhand-open-setup without a browser says what to run, without the token",
  { skip: needsBash },
  (t) => {
    // Linux, no DISPLAY: xdg-open is there but not used.
    const { status, said, got } = openSetup(t, { openers: ["xdg-open"] });
    assert.equal(status, 1);
    assert.equal(got["xdg-open"], "");
    assert.doesNotMatch(said, new RegExp(token));
    assert.doesNotMatch(said, /token=(old|[0-9a-f])/);
    assert.match(said, /https:\/\/deckhand\.example\.com/);

    assert.equal(
      openSetup(t, { url: "http://deckhand.example.com" }).status,
      2,
      "an address GitHub can't use",
    );
  },
);
