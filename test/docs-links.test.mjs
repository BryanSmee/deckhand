// Every reference to a section of docs/ resolves: its file exists and has the heading its
// anchor names (#953). Pages move (docs/repo-config.md split into docs/repo-config/) and
// headings get renamed: a link left behind would then land at the top of a page, or nowhere.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { posix } from "./helpers.mjs";
import { slugify } from "../docs/.vitepress/slug.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// What isn't the repository's own: packages, builds (the docs site's cache too), git's files,
// Claude Code's worktrees.
const SKIP = new Set(["node_modules", ".git", "dist", "cache", "coverage", ".claude"]);
const TEXT = /\.(mjs|js|ts|tsx|md|rego|ya?ml|json|sh|css|html)$|Dockerfile$/;

// The repository's files. Not `git ls-files`: the tests also run from a tarball without .git
// (AGENTS.md). A directory with a .git of its own is another checkout (a worktree, a scratch
// clone), its references resolved against its own docs/, not these.
function files(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return existsSync(join(path, ".git")) ? [] : files(path);
    return TEXT.test(entry.name) ? [path] : [];
  });
}

// GitHub's slug of a heading: lower case, without punctuation, spaces as dashes.
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

// A Markdown page's anchors: its headings' slugs (out of code blocks, a repeated one with
// -1, -2…), and its HTML ids.
const anchorsOf = new Map();
export function anchors(text) {
  const seen = new Map();
  const found = new Set();
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || !/^#{1,6} /.test(line)) continue;
    const base = slug(line.replace(/^#+ /, "").replace(/ #+$/, ""));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.add(n ? `${base}-${n}` : base);
  }
  for (const [, id] of text.matchAll(/<a (?:id|name)="([^"]+)"/g)) found.add(id);
  return found;
}

function problem(page, anchor) {
  if (!existsSync(page)) return "no such file";
  if (!anchor) return null;
  if (!anchorsOf.has(page)) anchorsOf.set(page, anchors(readFileSync(page, "utf8")));
  return anchorsOf.get(page).has(anchor) ? null : `no heading #${anchor}`;
}

// What a file points to in docs/: `docs/<page>.md#<anchor>` anywhere (code, messages, URLs to
// the repository on GitHub), and in a Markdown file its relative links too.
export function references(path, text) {
  const refs = [];
  for (const m of text.matchAll(/(?<![\w.-])docs\/([\w./-]+?\.md)#([\w-]+)/g)) {
    refs.push({ ref: m[0], page: join(root, "docs", m[1]), anchor: m[2], at: m.index });
  }
  if (path.endsWith(".md")) {
    for (const m of text.matchAll(/\]\(([^)\s]*?)(?:#([\w-]+))?\)/g)) {
      const [ref, target, anchor] = m;
      if (/^[a-z]+:/i.test(target) || target.startsWith("/")) continue;
      if (target && !target.endsWith(".md")) continue;
      refs.push({ ref, page: target ? resolve(dirname(path), target) : path, anchor, at: m.index });
    }
  }
  return refs;
}

test("every reference to docs/ names a page and a heading that exist", () => {
  const broken = [];
  let checked = 0;
  for (const path of files()) {
    const text = readFileSync(path, "utf8");
    for (const { ref, page, anchor, at } of references(path, text)) {
      checked++;
      const why = problem(page, anchor);
      if (!why) continue;
      const line = text.slice(0, at).split("\n").length;
      broken.push(`${posix(relative(root, path))}:${line}: ${ref} (${why})`);
    }
  }
  assert.deepEqual(broken, []);
  // The scan found what it looks for: the docs link to each other hundreds of times.
  assert.ok(checked > 300, String(checked));
});

test("slugs: GitHub's, repeated headings numbered", () => {
  assert.equal(slug("CI before the review"), "ci-before-the-review");
  assert.equal(slug("`review.rego`"), "reviewrego");
  assert.equal(slug("A run's own comments"), "a-runs-own-comments");
  assert.equal(slug("3. Use it"), "3-use-it");
  assert.equal(slug("Where a sandbox's hosts come from"), "where-a-sandboxs-hosts-come-from");
  const found = anchors("# A\n\n## Notes\n\n```sh\n# not a heading\n```\n\n## Notes\n");
  assert.deepEqual([...found], ["a", "notes", "notes-1"]);
});

// The docs site (docs/.vitepress) gives each heading the anchor GitHub does, so the references
// above land on both.
test("the site's slugs are GitHub's", () => {
  for (const heading of ["CI before the review", "review.rego", "3. Use it", "Run tokens (#441)"]) {
    assert.equal(slugify(heading), slug(heading));
  }
});

// Each page rendered as the site renders it: every anchor GitHub gives it is an id there. With
// the site's packages only (`npm ci` in docs/, the docs job in checks.yml).
const vitepress = join(root, "docs", "node_modules", "vitepress");
test(
  "every page's anchors are ids on the site",
  { skip: !existsSync(vitepress) && "no docs/node_modules (npm ci in docs/)" },
  async () => {
    const docs = join(root, "docs");
    // From docs/, where the site's packages are.
    const from = createRequire(join(docs, "package.json"));
    const { createMarkdownRenderer } = await import(pathToFileURL(from.resolve("vitepress")));
    const { default: site } = await import("../docs/.vitepress/config.mjs");
    const md = await createMarkdownRenderer(docs, site.markdown, site.base);
    const missing = [];
    for (const path of files(docs).filter((path) => path.endsWith(".md"))) {
      const text = readFileSync(path, "utf8");
      const html = md.render(text, { relativePath: posix(relative(docs, path)) });
      const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id));
      for (const anchor of anchors(text)) {
        if (!ids.has(anchor)) missing.push(`${posix(relative(root, path))}#${anchor}`);
      }
    }
    assert.deepEqual(missing, []);
  },
);
