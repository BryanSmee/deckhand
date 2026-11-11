// The deckhand CLI (cli/deckhand.mjs, #1034): .env's pin read and written, the upgrade notes an
// update shows, and up and update against the fake docker (fixtures/fake-docker.sh), in a plain
// folder and in a git checkout, with GitHub's answers from a fake fetch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  compareReleases,
  createCli,
  headings,
  main,
  newNotes,
  readVersion,
  slug,
  withVersion,
} from "../cli/deckhand.mjs";
import { needsBash, tempDir } from "./helpers.mjs";

test(".env: the pin read as compose reads it, and written keeping the rest", () => {
  assert.equal(readVersion("A=1\nDECKHAND_VERSION=0.2.0\n"), "0.2.0");
  assert.equal(readVersion("DECKHAND_VERSION=0.1.0\r\nDECKHAND_VERSION='edge'\r\n"), "edge");
  assert.equal(readVersion("DECKHAND_VERSION=0.2 # the minor\n"), "0.2");
  assert.equal(readVersion("# DECKHAND_VERSION=0.2.0\nA=1"), "");

  assert.equal(
    withVersion(
      "A=1\n# DECKHAND_VERSION=latest: a comment\nDECKHAND_VERSION=latest\nB=2\n",
      "0.2.0",
    ),
    "A=1\n# DECKHAND_VERSION=latest: a comment\nDECKHAND_VERSION=0.2.0\nB=2\n",
  );
  // A blank line before it and a CRLF file's line ends kept.
  assert.equal(
    withVersion("A=1\n\nDECKHAND_VERSION=latest\nB=2\n", "0.2.0"),
    "A=1\n\nDECKHAND_VERSION=0.2.0\nB=2\n",
  );
  assert.equal(
    withVersion("A=1\r\n  export DECKHAND_VERSION = latest\r\nB=2\r\n", "0.2.0"),
    "A=1\r\nDECKHAND_VERSION=0.2.0\r\nB=2\r\n",
  );
  assert.equal(withVersion("A=1", "0.2.0"), "A=1\nDECKHAND_VERSION=0.2.0\n");
  assert.equal(withVersion("", "edge"), "DECKHAND_VERSION=edge\n");
});

test("Upgrade notes: the sections a release added, with GitHub's anchors", () => {
  const before = "# Upgrade notes\n\n## Upgrading: a grants folder\n\ntext\n";
  const after =
    "# Upgrade notes\n\n## Upgrading: `+scan` for Redis's user (#614)\n\n```md\n## not a heading\n```\n" +
    "\n## Upgrading: a grants folder\n";
  assert.deepEqual(headings(after), [
    "Upgrading: `+scan` for Redis's user (#614)",
    "Upgrading: a grants folder",
  ]);
  assert.deepEqual(newNotes(before, after), ["Upgrading: `+scan` for Redis's user (#614)"]);
  assert.equal(
    slug("Upgrading: `+scan` for Redis's user (#614)"),
    "upgrading-scan-for-rediss-user-614",
  );
  assert.equal(compareReleases("0.10.0", "0.9.1"), 1);
  assert.equal(compareReleases("0.2.0", "0.2.0"), 0);
  assert.equal(compareReleases("0.1.9", "0.2.0"), -1);
});

const NOTES_V1 = "# Upgrade notes\n\n## Upgrading from v0.0.x (v0.1.0)\n";
const NOTES_V2 = "# Upgrade notes\n\n## Upgrading: the store (#700)\n\n" + NOTES_V1.slice(16);

// GitHub as the CLI reads it: the latest release, and the files of each ref (`files`: "ref path").
function github(files, latest = "v0.2.0") {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/releases/latest")) return Response.json({ tag_name: latest });
    const m = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/.exec(url);
    const text = m && files[`${m[1]} ${m[2]}`];
    return text === undefined ? new Response("Not Found", { status: 404 }) : new Response(text);
  };
  return { fetch, calls };
}

// A Deckhand's folder (`dir`, its compose.yaml and .env) and the fake docker on PATH, whose
// compose calls land in docker-calls.
function deckhand(t, envText, { dir } = {}) {
  const bin = tempDir(t);
  symlinkSync(join(import.meta.dirname, "fixtures", "fake-docker.sh"), join(bin, "docker"));
  dir ??= tempDir(t);
  if (!existsSync(join(dir, "compose.yaml"))) writeFileSync(join(dir, "compose.yaml"), "old\n");
  writeFileSync(join(dir, ".env"), envText);
  const logs = [];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const cli = (fetch, ask = async () => null) =>
    createCli({ dir, env, fetch, ask, log: (line) => logs.push(line) });
  const calls = () => {
    try {
      return readFileSync(join(bin, "docker-calls"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return { dir, bin, env, cli, logs, calls };
}

test(
  "up: no pin, the latest pinned and its compose.yaml; every image pulled, then up",
  { skip: needsBash },
  async (t) => {
    const d = deckhand(t, "CLAUDE_CODE_OAUTH_TOKEN=x\nDECKHAND_VERSION=latest\n");
    const gh = github({ "v0.2.0 compose.yaml": "new\n" });
    await d.cli(gh.fetch).up();
    assert.equal(
      readFileSync(join(d.dir, ".env"), "utf8"),
      "CLAUDE_CODE_OAUTH_TOKEN=x\nDECKHAND_VERSION=0.2.0\n",
    );
    assert.equal(readFileSync(join(d.dir, "compose.yaml"), "utf8"), "new\n");
    assert.equal(readFileSync(join(d.dir, "compose.yaml.bak"), "utf8"), "old\n");
    // Pinned before the pull: compose read 0.2.0 from .env.
    assert.deepEqual(d.calls(), ["compose pull (0.2.0)", "compose up -d (0.2.0)"]);
    assert.match(d.logs.join("\n"), /Pinning the latest release, 0\.2\.0/);
  },
);

test("up: a pin kept as it is, nothing asked of GitHub", { skip: needsBash }, async (t) => {
  for (const pinned of ["0.1.0", "0.1", "edge"]) {
    const d = deckhand(t, `DECKHAND_VERSION=${pinned}\n`);
    const gh = github({});
    await d.cli(gh.fetch).up();
    assert.deepEqual(gh.calls, []);
    assert.deepEqual(d.calls(), [`compose pull (${pinned})`, `compose up -d (${pinned})`]);
    assert.equal(readFileSync(join(d.dir, "compose.yaml"), "utf8"), "old\n");
  }
  const d = deckhand(t, "DECKHAND_VERSION=main\n");
  await assert.rejects(d.cli(github({}).fetch).up(), /a release \(1\.2\.3\), or edge/);
  assert.deepEqual(d.calls(), []);
});

test(
  "up and update: what they need, checked before anything changes",
  { skip: needsBash },
  async (t) => {
    const d = deckhand(t, "DECKHAND_VERSION=latest\n");
    const noEnv = createCli({ dir: tempDir(t), env: d.env, fetch: github({}).fetch, log() {} });
    await assert.rejects(noEnv.up(), /No compose\.yaml/);
    // No docker on PATH.
    const bare = createCli({
      dir: d.dir,
      env: { PATH: tempDir(t) },
      fetch: github({}).fetch,
      log() {},
    });
    await assert.rejects(bare.update(), /No docker here/);
    // A pull that fails says so, and up isn't called.
    writeFileSync(join(d.bin, "pull-fails"), "");
    await assert.rejects(
      d.cli(github({ "v0.2.0 compose.yaml": "new\n" }).fetch).up(),
      /docker compose pull failed/,
    );
    assert.deepEqual(d.calls(), ["compose pull (0.2.0)"]);
  },
);

test(
  "update: a plain folder, the notes since its release, asked, then moved",
  { skip: needsBash },
  async (t) => {
    const d = deckhand(t, "DECKHAND_VERSION=0.1.0\n");
    const gh = github({
      [`v0.1.0 docs/guides/upgrade-notes.md`]: NOTES_V1,
      [`v0.2.0 docs/guides/upgrade-notes.md`]: NOTES_V2,
      "v0.2.0 compose.yaml": "new\n",
    });
    const asked = [];
    // Said no: nothing changed.
    await d.cli(gh.fetch, async (q) => (asked.push(q), "n")).update();
    assert.deepEqual(asked, ["Update to 0.2.0 now? [y/N] "]);
    assert.equal(readVersion(readFileSync(join(d.dir, ".env"), "utf8")), "0.1.0");
    assert.deepEqual(d.calls(), []);
    const shown = d.logs.join("\n");
    assert.match(shown, /- Upgrading: the store \(#700\)/);
    assert.match(
      shown,
      /https:\/\/github\.com\/BryanSmee\/deckhand\/blob\/v0\.2\.0\/docs\/guides\/upgrade-notes\.md#upgrading-the-store-700/,
    );
    assert.doesNotMatch(shown, /v0\.0\.x/);
    // No terminal, no --yes: refused.
    await assert.rejects(d.cli(gh.fetch).update(), /deckhand update --yes/);
    // --yes.
    await d.cli(gh.fetch).update("v0.2.0", { yes: true });
    assert.equal(readVersion(readFileSync(join(d.dir, ".env"), "utf8")), "0.2.0");
    assert.equal(readFileSync(join(d.dir, "compose.yaml"), "utf8"), "new\n");
    assert.deepEqual(d.calls(), ["compose pull (0.2.0)", "compose up -d (0.2.0)"]);
  },
);

test(
  "update: no notes, nothing asked; the same release pulled again; versions it refuses",
  { skip: needsBash },
  async (t) => {
    const d = deckhand(t, "DECKHAND_VERSION=0.1.0\n");
    const gh = github({
      [`v0.1.0 docs/guides/upgrade-notes.md`]: NOTES_V1,
      [`v0.1.1 docs/guides/upgrade-notes.md`]: NOTES_V1,
      "v0.1.1 compose.yaml": "old\n",
    });
    await d.cli(gh.fetch, () => assert.fail("asked")).update("0.1.1");
    assert.match(d.logs.join("\n"), /No upgrade notes between 0\.1\.0 and 0\.1\.1/);
    await d.cli(gh.fetch, () => assert.fail("asked")).update("0.1.1");
    assert.match(d.logs.join("\n"), /Already on 0\.1\.1/);
    assert.deepEqual(d.calls(), [
      "compose pull (0.1.1)",
      "compose up -d (0.1.1)",
      "compose pull (0.1.1)",
      "compose up -d (0.1.1)",
    ]);
    // An unknown running release: the page alone, and asked.
    const latest = deckhand(t, "DECKHAND_VERSION=latest\n");
    const asked = [];
    await latest.cli(gh.fetch, async (q) => (asked.push(q), "")).update("0.1.1");
    assert.equal(asked.length, 1);
    assert.match(
      latest.logs.join("\n"),
      /since the release you ran \(latest\): https:\/\/github\.com\/.*\/blob\/v0\.1\.1\//,
    );
    await assert.rejects(d.cli(gh.fetch).update("0.2"), /a release \(1\.2\.3\), latest or edge/);
    await assert.rejects(d.cli(gh.fetch).update("1.0.0", { yes: true }), /of 1\.0\.0.*404/);
    assert.equal(readVersion(readFileSync(join(d.dir, ".env"), "utf8")), "0.1.1");
  },
);

// A clone of a repository whose tags v0.1.0 and v0.2.0 have their own compose.yaml, on v0.1.0,
// and main a commit past v0.2.0. v0.1.0 predates the deckhand command (no cli/deckhand.mjs).
function checkout(t) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: join(tempDir(t), "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = tempDir(t);
  git(origin, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(origin, ".gitignore"), ".env\n");
  for (const version of ["0.1.0", "0.2.0", "edge"]) {
    writeFileSync(join(origin, "compose.yaml"), `${version}\n`);
    if (version === "0.2.0") {
      mkdirSync(join(origin, "cli"));
      writeFileSync(join(origin, "cli", "deckhand.mjs"), "");
    }
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", version);
    if (version !== "edge") git(origin, "tag", `v${version}`);
  }
  const dir = join(tempDir(t), "deckhand");
  mkdirSync(dir);
  git(dir, "clone", "--quiet", origin, ".");
  git(dir, "checkout", "--quiet", "--detach", "v0.1.0");
  return { dir, git: (...args) => git(dir, ...args), env };
}

test(
  "update: a git checkout moved to the release's tag or to main, never over local changes",
  { skip: needsBash },
  async (t) => {
    const repo = checkout(t);
    const d = deckhand(t, "DECKHAND_VERSION=0.1.0\n", { dir: repo.dir });
    d.env.GIT_CONFIG_GLOBAL = repo.env.GIT_CONFIG_GLOBAL;
    d.env.GIT_CONFIG_NOSYSTEM = "1";
    const gh = github({
      [`v0.1.0 docs/guides/upgrade-notes.md`]: NOTES_V1,
      [`v0.2.0 docs/guides/upgrade-notes.md`]: NOTES_V2,
      [`main docs/guides/upgrade-notes.md`]: NOTES_V2,
    });
    writeFileSync(join(repo.dir, "compose.yaml"), "mine\n");
    await assert.rejects(d.cli(gh.fetch).update(undefined, { yes: true }), /local changes/);
    assert.equal(readVersion(readFileSync(join(repo.dir, ".env"), "utf8")), "0.1.0");
    assert.deepEqual(d.calls(), []);

    repo.git("checkout", "--quiet", "--", "compose.yaml");
    await d.cli(gh.fetch).update(undefined, { yes: true });
    assert.equal(repo.git("describe", "--tags", "--exact-match"), "v0.2.0");
    assert.equal(readFileSync(join(repo.dir, "compose.yaml"), "utf8"), "0.2.0\n");
    assert.ok(!existsSync(join(repo.dir, "compose.yaml.bak")));
    assert.equal(readVersion(readFileSync(join(repo.dir, ".env"), "utf8")), "0.2.0");
    assert.deepEqual(d.calls(), ["compose pull (0.2.0)", "compose up -d (0.2.0)"]);
    // No compose.yaml asked of GitHub: the checkout has it.
    assert.ok(gh.calls.every((url) => !url.endsWith("compose.yaml")));

    // edge: main's newest commit.
    await d.cli(gh.fetch).update("edge", { yes: true });
    assert.equal(readFileSync(join(repo.dir, "compose.yaml"), "utf8"), "edge\n");
    assert.equal(repo.git("rev-parse", "HEAD"), repo.git("rev-parse", "origin/main"));
    assert.equal(readVersion(readFileSync(join(repo.dir, ".env"), "utf8")), "edge");
    assert.match(d.logs.join("\n"), /The checkout is on origin\/main now/);
  },
);

test(
  "update from a release older than the notes' page (0.0.x): every section listed",
  { skip: needsBash },
  async (t) => {
    const d = deckhand(t, "DECKHAND_VERSION=0.0.2\n");
    const gh = github({
      [`v0.1.0 docs/guides/upgrade-notes.md`]: NOTES_V1,
      "v0.1.0 compose.yaml": "new\n",
    });
    await d.cli(gh.fetch).update("0.1.0", { yes: true });
    assert.ok(gh.calls.some((url) => url.endsWith("/v0.0.2/docs/guides/upgrade-notes.md")));
    assert.match(d.logs.join("\n"), /- Upgrading from v0\.0\.x \(v0\.1\.0\)/);
    assert.deepEqual(d.calls(), ["compose pull (0.1.0)", "compose up -d (0.1.0)"]);
  },
);

test(
  "up: a checkout that isn't on the pinned release's tag, warned and left there",
  { skip: needsBash },
  async (t) => {
    const repo = checkout(t);
    const d = deckhand(t, "DECKHAND_VERSION=0.2.0\n", { dir: repo.dir });
    d.env.GIT_CONFIG_GLOBAL = repo.env.GIT_CONFIG_GLOBAL;
    d.env.GIT_CONFIG_NOSYSTEM = "1";
    const warning = /The checkout isn't on v0\.2\.0, the release \.env pins/;
    await d.cli(github({}).fetch).up();
    assert.match(d.logs.join("\n"), warning);
    assert.equal(repo.git("describe", "--tags", "--exact-match"), "v0.1.0");
    assert.deepEqual(d.calls(), ["compose pull (0.2.0)", "compose up -d (0.2.0)"]);
    // On the tag: nothing said.
    repo.git("checkout", "--quiet", "--detach", "v0.2.0");
    d.logs.length = 0;
    await d.cli(github({}).fetch).up();
    assert.doesNotMatch(d.logs.join("\n"), /isn't on/);
  },
);

test(
  "A git checkout never moved to a release without the deckhand command",
  { skip: needsBash },
  async (t) => {
    const repo = checkout(t);
    repo.git("checkout", "--quiet", "--detach", "v0.2.0");
    const d = deckhand(t, "DECKHAND_VERSION=0.2.0\n", { dir: repo.dir });
    d.env.GIT_CONFIG_GLOBAL = repo.env.GIT_CONFIG_GLOBAL;
    d.env.GIT_CONFIG_NOSYSTEM = "1";
    // Refused before anything is asked: the checkout, .env and the services as they were.
    await assert.rejects(
      d.cli(github({}).fetch, () => assert.fail("asked")).update("0.1.0"),
      /v0\.1\.0 has no cli\/deckhand\.mjs: it predates the deckhand command.*Nothing changed/,
    );
    assert.equal(repo.git("describe", "--tags", "--exact-match"), "v0.2.0");
    assert.equal(readVersion(readFileSync(join(repo.dir, ".env"), "utf8")), "0.2.0");
    // up, when the latest release is one without it: nothing pinned.
    writeFileSync(join(repo.dir, ".env"), "DECKHAND_VERSION=latest\n");
    await assert.rejects(d.cli(github({}, "v0.1.0").fetch).up(), /predates the deckhand command/);
    assert.equal(readVersion(readFileSync(join(repo.dir, ".env"), "utf8")), "latest");
    assert.equal(repo.git("describe", "--tags", "--exact-match"), "v0.2.0");
    assert.deepEqual(d.calls(), []);
  },
);

test(
  "A fork's releases (DECKHAND_REPOSITORY), and the shell's DECKHAND_VERSION left out",
  { skip: needsBash },
  async (t) => {
    const d = deckhand(t, "DECKHAND_VERSION=latest\nDECKHAND_REPOSITORY=someone/fork\n");
    // compose would run the shell's release rather than the one .env pins.
    d.env.DECKHAND_VERSION = "0.1.0";
    const gh = github({ "v0.2.0 compose.yaml": "new\n" });
    await d.cli(gh.fetch).up();
    assert.deepEqual(gh.calls, [
      "https://api.github.com/repos/someone/fork/releases/latest",
      "https://raw.githubusercontent.com/someone/fork/v0.2.0/compose.yaml",
    ]);
    assert.deepEqual(d.calls(), ["compose pull (0.2.0)", "compose up -d (0.2.0)"]);
    assert.match(d.logs.join("\n"), /Your shell sets DECKHAND_VERSION=0\.1\.0/);
  },
);

test("main: its version, its usage, and an unknown command", async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  await main(["--version"], {}, { log });
  assert.match(lines.pop(), /^\d+\.\d+\.\d+$/);
  await main(["help"], {}, { log });
  assert.match(lines.pop(), /deckhand update \[<version>\]/);
  const before = process.exitCode;
  await main(["down"], {}, { log });
  assert.equal(process.exitCode, 2);
  process.exitCode = before;
});
