#!/usr/bin/env node
// deckhand (#1034): starts and updates a Deckhand on Docker Compose, from the folder of its
// compose.yaml and .env. One file, no dependency, Node 20 or later, on Linux, macOS and WSL2,
// attached to each release like the machine driver:
//
//   deckhand up                 the release .env pins (the latest, pinned there, when it pins
//                               none), every image pulled, the sandbox's too, then started
//   deckhand update [<version>] the upgrade notes since the release running, then the same
//
// A pinned release rather than `latest`: which release runs is then the one .env names, its
// compose.yaml the one beside it, and the sandbox image, which an updater following running
// containers never pulls (compose's `sandbox` service exits at once), pulled with the rest.
// compose.yaml follows the release: a git checkout moves to its tag, any other folder gets the
// tag's file (the old one kept as compose.yaml.bak).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The CLI's version: the release workflow writes the tag's.
export const VERSION = "0.1.0";
// Where the releases, compose.yaml and the upgrade notes come from (DECKHAND_REPOSITORY: a fork).
export const REPOSITORY = "BryanSmee/deckhand";
export const NOTES = "docs/guides/upgrade-notes.md";
// A release update takes (the images' tag: 1.2.3, no "v"); what .env may pin besides (1.2, edge).
const RELEASE = /^\d+\.\d+\.\d+$/;
const PINNED = /^(\d+\.\d+(\.\d+)?|edge)$/;

// --- .env ------------------------------------------------------------------------------------

// The value .env gives DECKHAND_VERSION, as compose reads it (the last line setting it), or "".
export function readVersion(text) {
  let version = "";
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?DECKHAND_VERSION\s*=\s*(.*?)\s*$/.exec(line);
    // A quoted value as it is, an unquoted one up to its comment.
    if (m) version = /^(["'])(.*)\1$/.exec(m[1])?.[2] ?? m[1].replace(/\s+#.*$/, "");
  }
  return version;
}

// .env with DECKHAND_VERSION set to `version`: its lines setting it replaced (a comment
// mentioning it left as it is), or one added at the end. The rest kept byte for byte.
export function withVersion(text, version) {
  const line = `DECKHAND_VERSION=${version}`;
  const setting = /^\s*(?:export\s+)?DECKHAND_VERSION\s*=.*$/gm;
  if (setting.test(text)) return text.replace(setting, line);
  const sep = !text || text.endsWith("\n") ? "" : "\n";
  return `${text}${sep}${line}\n`;
}

// --- Upgrade notes ---------------------------------------------------------------------------

// The `## ` headings of a Markdown page, code blocks skipped.
export function headings(text) {
  const out = [];
  let fence = null;
  for (const line of String(text).split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f && (!fence || f[1].startsWith(fence))) fence = fence ? null : f[1];
    else if (!fence && line.startsWith("## ")) out.push(line.slice(3).trim());
  }
  return out;
}

// GitHub's anchor of a heading: lower case, punctuation dropped, spaces as hyphens.
export const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

// The notes a release's page has and an older one's hadn't: what an update to it may need.
export function newNotes(before, after) {
  const seen = new Set(headings(before));
  return headings(after).filter((heading) => !seen.has(heading));
}

// -1, 0 or 1, as release a is older, the same or newer than b.
export function compareReleases(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}

// The git ref of a release, or main for edge.
export const refOf = (version) => (version === "edge" ? "main" : `v${version}`);

// --- The commands ----------------------------------------------------------------------------

// `run(command, args, { cwd, env, capture })`: its exit code, and its output when captured.
// `ask(question)`: the answer typed, or null without a terminal. Both injected by the tests.
export function createCli({
  dir,
  env = process.env,
  fetch = globalThis.fetch,
  run = runCommand,
  ask = askTerminal,
  log = console.log,
  repository = env.DECKHAND_REPOSITORY || REPOSITORY,
}) {
  const files = {
    compose: join(dir, "compose.yaml"),
    env: join(dir, ".env"),
  };
  const call = (command, args, capture = false) => run(command, args, { cwd: dir, env, capture });

  async function get(url, what) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": `deckhand-cli/${VERSION}` } });
    } catch (error) {
      throw new Error(`Couldn't read ${what} (${url}): ${error.cause?.message ?? error.message}`);
    }
    if (!res.ok) throw new Error(`Couldn't read ${what} (${url}): ${res.status}`);
    return res;
  }
  const raw = async (version, path) =>
    (
      await get(
        `https://raw.githubusercontent.com/${repository}/${refOf(version)}/${path}`,
        `${path} of ${version}`,
      )
    ).text();

  async function latestRelease() {
    const url = `https://api.github.com/repos/${repository}/releases/latest`;
    const tag = String((await (await get(url, "the latest release")).json()).tag_name ?? "");
    const version = tag.replace(/^v/, "");
    if (!RELEASE.test(version)) throw new Error(`The latest release is ${tag}: not a version.`);
    return version;
  }

  // Before anything changes: the folder is a Deckhand's, and docker has compose.
  async function check() {
    if (!existsSync(files.compose))
      throw new Error(
        `No compose.yaml in ${dir}: run deckhand from the folder of your Deckhand (or --dir).`,
      );
    if (!existsSync(files.env))
      throw new Error(
        `No .env in ${dir}: cp .env.example .env, then fill it in (the quick start).`,
      );
    let result;
    try {
      result = await call("docker", ["compose", "version"], true);
    } catch {
      throw new Error("No docker here: Deckhand needs Docker Engine 26 or later.");
    }
    if (result.code !== 0)
      throw new Error("docker compose failed: Deckhand needs Docker's compose plugin.");
  }

  async function compose(...args) {
    const { code } = await call("docker", ["compose", ...args]);
    if (code !== 0) throw new Error(`docker compose ${args.join(" ")} failed (exit ${code}).`);
  }

  async function git(...args) {
    const { code, stdout } = await call("git", args, true);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${code}).`);
    return stdout;
  }

  // compose.yaml as `version` has it: a checkout moved to its tag (its local changes refused,
  // as the move would carry them onto files they weren't written for), else the tag's file.
  async function follow(version) {
    if (existsSync(join(dir, ".git"))) {
      if ((await git("status", "--porcelain", "--untracked-files=no")).trim())
        throw new Error(
          "The checkout has local changes (git status): commit or stash them first. Your own " +
            "changes to compose.yaml belong in compose.override.yaml.",
        );
      await git("fetch", "--quiet", "--tags", "origin");
      const ref = version === "edge" ? "origin/main" : `v${version}`;
      await git("checkout", "--quiet", "--detach", ref);
      log(`The checkout is on ${ref} now.`);
      return;
    }
    const text = await raw(version, "compose.yaml");
    if (readFileSync(files.compose, "utf8") === text) return;
    copyFileSync(files.compose, `${files.compose}.bak`);
    writeFileSync(files.compose, text);
    log(`compose.yaml is ${version}'s now (the old one: compose.yaml.bak).`);
  }

  const pin = (version) =>
    writeFileSync(files.env, withVersion(readFileSync(files.env, "utf8"), version));

  async function start(version) {
    await compose("pull");
    await compose("up", "-d");
    log(
      `Deckhand ${version} is up. On a first start, edge's log has the setup link: ` +
        "docker compose logs edge",
    );
  }

  // The release .env pins; with none (or `latest`), the latest, pinned.
  async function up() {
    await check();
    let version = readVersion(readFileSync(files.env, "utf8"));
    if (!version || version === "latest") {
      version = await latestRelease();
      log(`Pinning the latest release, ${version}, in .env (deckhand update moves it).`);
      await follow(version);
      pin(version);
    } else if (!PINNED.test(version)) {
      throw new Error(`.env's DECKHAND_VERSION is ${version}: a release (1.2.3), or edge.`);
    }
    await start(version);
  }

  // The upgrade notes between the release running and `target`: the sections its page has and
  // the running one's hasn't, or the page alone when the running release is no single tag.
  async function notes(current, target) {
    const page = `https://github.com/${repository}/blob/${refOf(target)}/${NOTES}`;
    if (!RELEASE.test(current)) {
      log(`Read the upgrade notes since the release you ran (${current || "unknown"}): ${page}`);
      return true;
    }
    if (target !== "edge" && compareReleases(target, current) < 0) {
      log(`${target} is older than ${current}: what a release moved isn't moved back (${page}).`);
      return true;
    }
    const added = newNotes(await raw(current, NOTES), await raw(target, NOTES));
    if (!added.length) {
      log(`No upgrade notes between ${current} and ${target}.`);
      return false;
    }
    log(`The upgrade notes since ${current}: read them, they may need a step of yours.\n`);
    for (const heading of added) log(`- ${heading}\n  ${page}#${slug(heading)}`);
    log("");
    return true;
  }

  async function update(requested = "latest", { yes = false } = {}) {
    await check();
    const current = readVersion(readFileSync(files.env, "utf8"));
    let target = requested.replace(/^v(?=\d)/, "");
    if (target === "latest") target = await latestRelease();
    if (!RELEASE.test(target) && target !== "edge")
      throw new Error(`deckhand update ${requested}: a release (1.2.3), latest or edge.`);
    if (target === current && target !== "edge") {
      log(`Already on ${target}: its images pulled again.`);
    } else {
      log(`Updating from ${current || "latest"} to ${target}.`);
      if ((await notes(current, target)) && !yes) {
        const answer = await ask(`Update to ${target} now? [y/N] `);
        if (answer === null)
          throw new Error("No terminal to ask: read the notes, then deckhand update --yes.");
        if (!/^y(es)?$/i.test(answer.trim())) {
          log("Nothing changed.");
          return;
        }
      }
      await follow(target);
      pin(target);
    }
    await start(target);
  }

  return { up, update, latestRelease };
}

// --- The command line ------------------------------------------------------------------------

function runCommand(command, args, { cwd, env, capture }) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout }));
  });
}

function askTerminal(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => rl.question(prompt, (a) => (rl.close(), done(a))));
}

const USAGE = `deckhand ${VERSION}: starts and updates your Deckhand on Docker Compose.

  deckhand up                  start the release .env pins (none: the latest, pinned)
  deckhand update [<version>]  move to a release (1.2.3; the latest without one) or edge:
                               its upgrade notes, then its images pulled and started

Run it from the folder of your compose.yaml and .env, or give it: --dir <folder>.
--yes: update without asking, once you read the notes.`;

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const args = [];
  let dir = process.cwd();
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yes" || argv[i] === "-y") yes = true;
    else if (argv[i] === "--dir") dir = argv[++i] ?? "";
    else args.push(argv[i]);
  }
  const [command, arg] = args;
  if (command === "--version" || command === "version") return log(VERSION);
  if (command === "up" || command === "update") {
    if (!dir) throw new Error("--dir <folder>: the folder of your compose.yaml.");
    const cli = createCli({ dir: resolve(dir), env, log, ...deps });
    return command === "up" ? cli.up() : cli.update(arg, { yes });
  }
  log(USAGE);
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
    console.error(error.message);
    process.exit(1);
  });
}
