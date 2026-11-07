import { defineConfig } from "vitepress";
import { posix } from "node:path";
import { rego } from "./rego.mjs";
import { slugify } from "./slug.mjs";

const repo = "https://github.com/BryanSmee/deckhand";

// A relative link to what isn't a page (the code, compose.yaml, AGENTS.md, a folder) goes to it
// on GitHub: the pages keep their relative links, which work there, and the site has only the
// pages.
function linksToGitHub(md) {
  const open =
    md.renderer.rules.link_open ??
    ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = tokens[i].attrGet("href");
    if (href && !/^([a-z][a-z\d+.-]*:|\/|#)/i.test(href)) {
      const [path, anchor] = href.split("#");
      const target = posix.normalize(posix.join("docs", posix.dirname(env.relativePath), path));
      if (target.startsWith("../"))
        throw new Error(`${env.relativePath}: ${href} leaves the repository`);
      if (!target.startsWith("docs/") || !path.endsWith(".md")) {
        const kind = path.endsWith("/") ? "tree" : "blob";
        tokens[i].attrSet("href", `${repo}/${kind}/main/${target}${anchor ? `#${anchor}` : ""}`);
      }
    }
    return open(tokens, i, options, env, self);
  };
}

// Inline code as it is written: Vue would read a `${{ secrets.NAME }}` there as its own
// interpolation (code blocks already get v-pre).
function inlineCodeAsIs(md) {
  const code = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, i, options, env, self) =>
    code(tokens, i, options, env, self).replace(/^<code/, "<code v-pre");
}

// An <img src="images/…"> in a page's HTML is relative on GitHub, but Vite reads a path without
// ./ as a package to import: give it one.
function relativeImages(md) {
  const fix = (html) => html.replace(/\b(src|srcset)="(?![a-z][a-z\d+.-]*:|[./#])/gi, '$1="./');
  md.core.ruler.push("relative_images", (state) => {
    for (const token of state.tokens) {
      if (token.type === "html_block") token.content = fix(token.content);
      for (const child of token.children ?? []) {
        if (child.type === "html_inline") child.content = fix(child.content);
      }
    }
  });
}

export default defineConfig({
  title: "Deckhand",
  description: "Runs Claude Code on your GitHub issues and pull requests, on your own server.",
  base: "/deckhand/",
  cleanUrls: true,
  // The local search index of a few long pages is one big chunk: expected.
  vite: { build: { chunkSizeWarningLimit: 2000 } },
  markdown: {
    anchor: { slugify },
    languages: [rego],
    // Redis's config reads as key-value pairs.
    languageAlias: { conf: "properties" },
    config: (md) => md.use(linksToGitHub).use(inlineCodeAsIs).use(relativeImages),
  },
  themeConfig: {
    search: { provider: "local" },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path` },
    nav: [
      { text: "Get started", link: "/get-started/quick-start" },
      { text: "Guides", link: "/guides/install" },
      { text: "Reference", link: "/repo-config" },
      { text: "Security", link: "/security" },
    ],
    sidebar: [
      {
        text: "Get started",
        items: [
          { text: "What is Deckhand", link: "/get-started/what-is-deckhand" },
          { text: "Quick start", link: "/get-started/quick-start" },
          { text: "Core ideas", link: "/get-started/core-ideas" },
        ],
      },
      // Guides: one page per task, in the order an operator meets them (#984).
      {
        text: "Guides: install",
        items: [
          { text: "Install with Compose", link: "/guides/install" },
          { text: "Create the GitHub App", link: "/guides/github-app" },
          { text: "Start runs", link: "/guides/runs" },
          { text: "Repositories and onboarding", link: "/guides/repositories" },
          { text: "Deckhand on Kubernetes", link: "/kubernetes" },
        ],
      },
      {
        text: "Guides: use",
        items: [
          { text: "The dashboard", link: "/guides/dashboard" },
          { text: "MCP clients", link: "/guides/mcp-clients" },
          { text: "Your own machine", link: "/guides/machines" },
          { text: "Chats", link: "/guides/chats" },
          { text: "Auto-pickup", link: "/guides/auto-pickup" },
        ],
      },
      {
        text: "Guides: agents",
        items: [
          { text: "Agents and providers", link: "/guides/agents" },
          { text: "Claude Code", link: "/guides/claude-code" },
          { text: "Codex", link: "/guides/codex" },
          { text: "Antigravity CLI", link: "/guides/antigravity" },
          { text: "Fallbacks", link: "/guides/fallbacks" },
        ],
      },
      {
        text: "Guides: operate",
        items: [
          { text: "Logs and health checks", link: "/guides/logs" },
          { text: "Metrics", link: "/guides/metrics" },
          { text: "Metrics by service", link: "/guides/metrics-list" },
          { text: "Updating", link: "/guides/updating" },
          { text: "Upgrade notes", link: "/guides/upgrade-notes" },
          { text: "Running two copies", link: "/guides/two-copies" },
        ],
      },
      {
        text: "Guides: services and storage",
        items: [
          { text: "What the services hold", link: "/guides/services" },
          { text: "The store", link: "/guides/store" },
          { text: "Blob storage", link: "/guides/blob-storage" },
          { text: "Container engine", link: "/guides/container-engine" },
          { text: "Download cache", link: "/guides/download-cache" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Server settings", link: "/settings" },
          { text: "Repository config", link: "/repo-config" },
          { text: "Modes", link: "/repo-config/modes" },
          { text: "Reviews", link: "/repo-config/reviews" },
          { text: "Issues", link: "/repo-config/issues" },
          { text: "Policies", link: "/repo-config/policies" },
          { text: "Policy inputs", link: "/repo-config/policy-inputs" },
        ],
      },
      {
        text: "Security",
        items: [{ text: "Security model", link: "/security" }],
      },
      {
        text: "Contributing",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Services", link: "/services" },
          { text: "The dashboard's languages", link: "/dashboard-languages" },
          { text: "Dashboard redesign", link: "/design/dashboard-redesign" },
        ],
      },
    ],
  },
});
