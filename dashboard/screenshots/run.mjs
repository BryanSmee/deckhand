// Takes the docs' pictures again (#987): `npm run screenshots` from dashboard/. It starts the
// dashboard's dev server, answers its API with the fake data of src/shots.ts (Playwright
// routes: no edge, no orchestrator), and saves each page at desktop and phone width, in the
// light and dark themes, under docs/images/, with the README's hero (hero.html) beside them.
// Never pointed at a real install: what it shows is fake by construction.
//
// Needs Playwright and its Chromium, which the dashboard doesn't depend on: from its own
// node_modules if it is there, else a global one (`npm i -g playwright && npx playwright
// install chromium`; NODE_PATH, which createRequire() reads where ESM's import doesn't).
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { LIVE_RUN, LIVE_TASK, LOG, ROUTES, STATE } from "../src/shots.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "..", "docs", "images");

function playwright() {
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    throw new Error(
      "Playwright isn't installed: npm i -g playwright && npx playwright install chromium",
    );
  }
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const THEMES = ["light", "dark"];

// Each picture: its name, the address it opens and what it does there before the shot.
const task = encodeURIComponent(LIVE_TASK);
const PAGES = [
  { name: "overview", hash: "#/" },
  { name: "run-log", hash: `#/tasks?task=${task}&run=${LIVE_RUN}`, ready: "git push origin" },
  {
    name: "config",
    hash: "#/settings/repositories/acme/app",
    ready: "narrowed from ALLOWED_USERS",
  },
  { name: "new-request", hash: "#/", act: newIdea },
];

// New request › Idea, on acme/app, with an idea written in.
async function newIdea(page) {
  await page.getByRole("button", { name: "New request" }).first().click();
  await page.getByRole("menuitem", { name: "Idea" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Repository" }).selectOption("acme/app");
  await dialog.getByRole("textbox").first().fill("Per-repo budgets for runs");
  await dialog
    .getByRole("textbox")
    .nth(1)
    .fill("Stop a repository's runs for the day once they have used the minutes its config gives.");
}

// The API's answers: a GET of ROUTES as JSON, the live run's log as one event of its stream,
// anything else a 404 (what a page shot doesn't read).
async function fakeApi(page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*?\/api\//, "");
    if (path === `runs/${LIVE_RUN}/stream`) {
      const body = `id: 1\nevent: entries\ndata: ${JSON.stringify(LOG)}\n\n`;
      return route.fulfill({ contentType: "text/event-stream", body });
    }
    if (route.request().method() === "GET" && Object.hasOwn(ROUTES, path)) {
      return route.fulfill({ json: ROUTES[path] });
    }
    return route.fulfill({ status: 404, json: {} });
  });
}

async function shoot(browser, base, viewport, theme) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  // The fixture's clock: "7 min ago" stays 7 minutes whenever this runs.
  await page.clock.setFixedTime(STATE.now);
  await fakeApi(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const shot of PAGES) {
    await page.goto(`${base}/${shot.hash}`);
    await page
      .getByText(shot.ready ?? "acme/app")
      .first()
      .waitFor({ state: "attached" });
    await shot.act?.(page);
    // Fonts and the last poll's render.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const file = `dashboard-${shot.name}-${viewport}-${theme}.png`;
    await page.screenshot({ path: join(out, file) });
    console.log(file);
  }
  await context.close();
  if (errors.length) throw new Error(`the page failed: ${errors.join("; ")}`);
}

// The README's hero, 1200 px wide, in each theme.
async function hero(browser, base) {
  for (const theme of THEMES) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 400 },
      colorScheme: theme,
      deviceScaleFactor: 2,
    });
    await page.goto(`${base}/screenshots/hero.html`);
    await page.evaluate(() => document.fonts.ready);
    const file = `hero-${theme}.png`;
    await page.locator("main").screenshot({ path: join(out, file) });
    console.log(file);
    await page.close();
  }
}

const server = await createServer({
  root,
  logLevel: "warn",
  server: { port: 0, strictPort: false, host: "127.0.0.1" },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await playwright().chromium.launch();
try {
  await mkdir(out, { recursive: true });
  for (const viewport of Object.keys(VIEWPORTS)) {
    for (const theme of THEMES) await shoot(browser, base, viewport, theme);
  }
  await hero(browser, base);
} finally {
  await browser.close();
  await server.close();
}
