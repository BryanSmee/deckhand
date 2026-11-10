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
// What isn't the repository's own: packages, builds, git's files, Claude Code's worktrees, and
// the docs site's cache (by its path: a cache/ of the repository's own is scanned).
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".claude"]);
const SKIP_PATHS = new Set([join(root, "docs", ".vitepress", "cache")]);
const TEXT = /\.(mjs|js|ts|tsx|md|rego|ya?ml|json|sh|css|html)$|Dockerfile$/;

// The repository's files. Not `git ls-files`: the tests also run from a tarball without .git
// (AGENTS.md). A directory with a .git of its own is another checkout (a worktree, a scratch
// clone), its references resolved against its own docs/, not these.
function files(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (SKIP.has(entry.name) || SKIP_PATHS.has(path)) return [];
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

// A Markdown page's headings, as written (out of code blocks); with `items`, the names its
// list items start with in bold too ("- **Temporary files in memory**: …"), which prose names
// as sections of their own.
export function headings(text, { items = false } = {}) {
  const found = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (/^#{1,6} /.test(line)) found.push(line.replace(/^#+ /, "").replace(/ #+$/, ""));
    const item = items && line.match(/^\s*[-*] \*\*(.+?)\*\*/);
    if (item) found.push(item[1]);
  }
  return found;
}

// A Markdown page's anchors: its headings' slugs (a repeated one with -1, -2…), and its HTML
// ids.
const anchorsOf = new Map();
export function anchors(text) {
  const seen = new Map();
  const found = new Set();
  for (const heading of headings(text)) {
    const base = slug(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.add(n ? `${base}-${n}` : base);
  }
  for (const [, id] of text.matchAll(/<a (?:id|name)="([^"]+)"/g)) found.add(id);
  return found;
}

// A section named in prose ("docs/<page>.md, Draining") is one of the page's headings or bold
// list items, as written but for its backticks, followed by the end of a word. The longest one
// that fits.
const plain = (text) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replaceAll("`", "");
export function section(names, after) {
  const rest = plain(after);
  return names
    .map(plain)
    .filter((name) => rest.startsWith(name) && !/^[\p{L}\p{N}'’-]/u.test(rest.slice(name.length)))
    .sort((a, b) => b.length - a.length)[0];
}

const headingsOf = new Map();
function problem(page, anchor, after) {
  if (!existsSync(page)) return "no such file";
  if (!headingsOf.has(page)) {
    headingsOf.set(page, headings(readFileSync(page, "utf8"), { items: true }));
  }
  if (after !== undefined) return section(headingsOf.get(page), after) ? null : "no such heading";
  if (!anchor) return null;
  if (!anchorsOf.has(page)) anchorsOf.set(page, anchors(readFileSync(page, "utf8")));
  return anchorsOf.get(page).has(anchor) ? null : `no heading #${anchor}`;
}

// What a file points to in docs/: `docs/<page>.md#<anchor>` anywhere (code, messages, URLs to
// the repository on GitHub), and the section `docs/<page>.md, <Heading>` names in prose; in a
// Markdown file its relative links too, and a bare `<page>.md#<anchor>` (a code block's
// comment), both relative to that file.
export function references(path, text) {
  const refs = [];
  for (const m of text.matchAll(/(?<![\w.-])docs\/([\w./-]+?\.md)#([\w-]+)/g)) {
    refs.push({ ref: m[0], page: join(root, "docs", m[1]), anchor: m[2], at: m.index });
  }
  for (const m of text.matchAll(/(?<![\w.-])docs\/([\w./-]+?\.md), (?=[A-Z`])/g)) {
    // What follows, its line breaks and their comment marks (//, #, *) read as one space.
    const after = text
      .slice(m.index + m[0].length, m.index + m[0].length + 300)
      .replace(/\s*\n\s*(?:\/\/|#|\*(?!\/))?\s*/g, " ");
    const ref = `${m[0]}${after.split(/[.;:)("]/)[0]}`.slice(0, 80);
    refs.push({ ref, page: join(root, "docs", m[1]), after, at: m.index });
  }
  if (path.endsWith(".md")) {
    for (const m of text.matchAll(/\]\(([^)\s]*?)(?:#([\w-]+))?\)/g)) {
      const [ref, target, anchor] = m;
      if (/^[a-z]+:/i.test(target) || target.startsWith("/")) continue;
      if (target && !target.endsWith(".md")) continue;
      refs.push({ ref, page: target ? resolve(dirname(path), target) : path, anchor, at: m.index });
    }
    // Not a link's (after its "](") nor a path's or URL's tail, nor the docs/ form above.
    for (const m of text.matchAll(
      /(?<![\w./:-]|\]\()(?!docs\/)((?:\.\.?\/)*[\w/-]+\.md)#([\w-]+)/g,
    )) {
      refs.push({ ref: m[0], page: resolve(dirname(path), m[1]), anchor: m[2], at: m.index });
    }
  }
  return refs;
}

// Stale, but in a file a run can't push (a workflow with write scopes): the maintainer's to fix.
// Listed here, it must stay broken until then. None today.
const KNOWN = new Set([]);

test("every reference to docs/ names a page and a heading that exist", () => {
  const broken = [];
  const known = new Set();
  let checked = 0;
  for (const path of files()) {
    const text = readFileSync(path, "utf8");
    for (const { ref, page, anchor, after, at } of references(path, text)) {
      checked++;
      const why = problem(page, anchor, after);
      if (!why) continue;
      const line = text.slice(0, at).split("\n").length;
      const where = `${posix(relative(root, path))}:${line}: ${ref}`;
      if (KNOWN.has(where)) known.add(where);
      else broken.push(`${where} (${why})`);
    }
  }
  assert.deepEqual(broken, []);
  // Fixed: remove it from KNOWN.
  assert.deepEqual(
    [...KNOWN].filter((ref) => !known.has(ref)),
    [],
  );
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

// The forms a page's move leaves behind outside links (#1007): a section named in prose, across
// a comment's line break, and a bare page#anchor in a Markdown code block.
test("references: sections named in prose, bare anchors in Markdown", () => {
  const names = ["Install", "Install with Helm", "The proxy's handover", "`review.rego`"];
  assert.equal(section(names, "Install, step 3)."), "Install");
  assert.equal(section(names, "Install with Helm: values"), "Install with Helm");
  assert.equal(section(names, "The proxy's handover)."), "The proxy's handover");
  assert.equal(section(names, "`review.rego`)"), "review.rego");
  assert.equal(section(names, "Installing"), undefined);
  assert.equal(section(names, "The proxy's"), undefined);
  const listed =
    "# Requirements\n\n- **An ingress** (or a load balancer)\n\n```\n- **Not this**\n```\n";
  assert.deepEqual(headings(listed), ["Requirements"]);
  assert.deepEqual(headings(listed, { items: true }), ["Requirements", "An ingress"]);

  // Built, not written out: the scan above reads this file too.
  const docs = "docs";
  const code = `// a rolling update (${docs}/services.md, The proxy's\n// handover). ${docs}/a.md, and more`;
  const [prose] = references(join(root, "x.mjs"), code);
  assert.equal(prose.ref, `${docs}/services.md, The proxy's handover`);
  assert.equal(section(["The proxy's handover"], prose.after), "The proxy's handover");
  assert.equal(references(join(root, "x.mjs"), code).length, 1);

  const page = join(root, "docs", "kubernetes.md");
  const md = `\`\`\`sh\n# (guides/agents.md#the-credentials-folder)\n\`\`\`\n[a](../x.md#b) ${docs}/c.md#d\n`;
  assert.deepEqual(
    references(page, md).map(({ page, anchor }) => [posix(relative(root, page)), anchor]),
    [
      ["docs/c.md", "d"],
      ["x.md", "b"],
      ["docs/guides/agents.md", "the-credentials-folder"],
    ],
  );
  // Bare in code, not Markdown: only the docs/ forms there.
  assert.deepEqual(references(join(root, "x.mjs"), "see agents.md#the-credentials-folder"), []);
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

// A ```mermaid block is drawn in the browser (docs/.vitepress/theme/Mermaid.vue), but its source
// stays text in the rendered page: the local search indexes the page with its tags stripped.
test(
  "a diagram's text stays in the page the site's search indexes",
  { skip: !existsSync(vitepress) && "no docs/node_modules (npm ci in docs/)" },
  async () => {
    const docs = join(root, "docs");
    const from = createRequire(join(docs, "package.json"));
    const { createMarkdownRenderer } = await import(pathToFileURL(from.resolve("vitepress")));
    const { default: site } = await import("../docs/.vitepress/config.mjs");
    const md = await createMarkdownRenderer(docs, site.markdown, site.base);
    const html = md.render('```mermaid\nflowchart LR\n  a["edge <b>&</b> {{ x }}"] --> b\n```\n', {
      relativePath: "page.md",
    });
    assert.match(html, /^<Mermaid code="[^"<>]+">/);
    assert.match(html, /<pre v-pre>/);
    assert.equal(
      html.replace(/<[^>]*>/g, "").trim(),
      "flowchart LR\n  a[&quot;edge &lt;b&gt;&amp;&lt;/b&gt; {{ x }}&quot;] --&gt; b",
    );
  },
);
