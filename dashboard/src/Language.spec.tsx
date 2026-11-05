// Settings › Preferences › Language, on a dashboard with a second catalog (a pseudo-Polish one
// made from the English, every text in brackets: locales/ mocked): picking it writes the shell
// and Preferences in it at once, without a reload, keeps it, and sets the root's lang; a plural
// takes the language's forms.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeAll, expect, test, vi } from "vitest";
import type { RepoList } from "./api";

vi.mock("./locales", async (original) => {
  const real = await original<typeof import("./locales")>();
  const pl = Object.fromEntries(
    Object.entries(real.CATALOGS.en).map(([key, text]) => [
      key,
      typeof text === "string"
        ? `[${text}]`
        : { one: `[${text.one}]`, few: "[{count} few]", many: "[{count} many]", other: "[other]" },
    ]),
  ) as unknown as (typeof real.CATALOGS)["en"];
  const CATALOGS = { ...real.CATALOGS, pl: { ...pl, "language.name": "Polski" } };
  const LANGUAGES = Object.keys(CATALOGS);
  return {
    ...real,
    CATALOGS,
    LANGUAGES,
    resolveLanguage: (choice: "system", preferred: readonly string[]) =>
      real.resolveLanguage(choice, preferred, LANGUAGES),
  };
});

// Imported again, after the mock: vitest.setup.ts has already loaded prefs.ts with the real
// catalogs.
let { Dashboard } = {} as typeof import("./App");
let { t } = {} as typeof import("./i18n");
let { applyPrefs, getPref, setPref } = {} as typeof import("./prefs");
let { makeState } = {} as typeof import("./testUtils");

beforeAll(async () => {
  vi.resetModules();
  ({ Dashboard } = await import("./App"));
  ({ t } = await import("./i18n"));
  ({ applyPrefs, getPref, setPref } = await import("./prefs"));
  ({ makeState } = await import("./testUtils"));
});

const repos = (): RepoList => ({
  repos: [],
  app: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  listedAt: null,
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
});

test("picked in Preferences: the shell and the page in it at once, kept, and the root's lang", () => {
  history.replaceState(null, "", "#/settings/preferences");
  render(<Dashboard state={makeState()} error={null} repos={repos()} />);
  const field = screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement;
  const options = [...field.options].map((o) => [o.value, o.text, o.lang]);
  expect(options).toEqual([
    ["system", "System (English)", ""],
    ["en", "English", "en"],
    ["fr", "Français", "fr"],
    ["pl", "Polski", "pl"],
  ]);
  expect(field.value).toBe("system");

  fireEvent.change(field, { target: { value: "pl" } });
  expect(localStorage.getItem("deckhand.language")).toBe("pl");
  expect(document.documentElement.lang).toBe("pl");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("[Settings]");
  const sidebar = within(screen.getByRole("complementary", { name: "Deckhand" }));
  expect(sidebar.getByRole("button", { name: "[New request]" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "[Appearance]" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "[Language]" })).toBeTruthy();

  // Back to System: English, the kept choice gone.
  fireEvent.change(screen.getByRole("combobox", { name: "[Language]" }), {
    target: { value: "system" },
  });
  expect(localStorage.getItem("deckhand.language")).toBeNull();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
  expect(document.documentElement.lang).toBe("en-US");
});

test("System picks the browser's first language with a catalog, with its region", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE", "pl-PL", "en-US"]);
  applyPrefs();
  expect(getPref("language")).toBe("system");
  expect(document.documentElement.lang).toBe("pl-PL");
  expect(t("shell.settings")).toBe("[Settings]");
});

test("plurals take the language's forms", () => {
  setPref("language", "pl" as "en");
  expect([1, 3, 5, 1.5].map((count) => t("review.notes", { count }))).toEqual([
    "[1 note]",
    "[3 few]",
    "[5 many]",
    "[other]",
  ]);
  // Its numbers too: Polish groups thousands with a space.
  expect(t("review.notes", { count: 12345 })).toMatch(/^\[12\s345 many\]$/);
});
