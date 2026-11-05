// i18n.ts and locales/: placeholders, plurals by Intl.PluralRules (a language with four forms
// among them), the language and locale a choice and the browser's languages come to, and the
// catalogs' types: `tsc` (npm run build) fails a catalog with a key missing or one too many,
// and a call without its params (each `@ts-expect-error` below fails the build once it stops
// being an error).
import { expect, test, vi } from "vitest";
import { and, locale, number, pick, t, tx } from "./i18n";
import { type Catalog, CATALOGS, resolveLanguage } from "./locales";
import { en } from "./locales/en";
import { setPref } from "./prefs";

test("placeholders filled, numbers written in the locale", () => {
  expect(t("shell.signedIn", { user: "octocat" })).toBe("Signed in as @octocat");
  expect(t("shell.repoRunning", { repo: "acme/app", count: 1234 })).toBe("acme/app: 1,234 running");
  expect(t("shell.settings")).toBe("Settings");
  expect(number(1234567)).toBe("1,234,567");
});

test("English plurals: one and other", () => {
  expect(t("review.notes", { count: 1 })).toBe("1 note");
  expect(t("review.notes", { count: 0 })).toBe("0 notes");
  expect(t("review.notes", { count: 2 })).toBe("2 notes");
  expect(t("shell.settingsWaiting", { count: 1 })).toBe("1 repository needs you");
  expect(t("shell.settingsWaiting", { count: 3 })).toBe("3 repositories need you");
});

test("a language with four forms: Polish's one, few, many and other", () => {
  const pl = {
    ...CATALOGS.en,
    "review.notes": {
      one: "{count} notatka",
      few: "{count} notatki",
      many: "{count} notatek",
      other: "{count} notatki (other)",
    },
  } satisfies Catalog;
  const form = (n: number) => pick(pl, "review.notes", n, "pl");
  expect(form(1)).toBe("{count} notatka");
  expect(form(3)).toBe("{count} notatki");
  expect(form(22)).toBe("{count} notatki");
  expect(form(5)).toBe("{count} notatek");
  expect(form(12)).toBe("{count} notatek");
  expect(form(1.5)).toBe("{count} notatki (other)");
  // A form the catalog leaves out: `other`.
  const short = { ...pl, "review.notes": { one: "a", other: "b" } } satisfies Catalog;
  expect(pick(short, "review.notes", 5, "pl")).toBe("b");
});

test("tx: elements in the placeholders", () => {
  const node = tx("prefs.shortcutsHelp", { key: "/" });
  expect(node.props.children).toEqual([
    "Single keys, like ",
    "/",
    " to search the tasks. They never fire while you type.",
  ]);
});

test("and: a list the language's way", () => {
  expect(and([])).toBe("");
  expect(and(["a"])).toBe("a");
  expect(and(["a", "b"])).toBe("a and b");
  expect(and(["a", "b", "c"])).toBe("a, b and c");
});

test("the language and locale: the browser's first one with a catalog, with its region", () => {
  expect(resolveLanguage("system", ["de-DE", "en-GB", "en-US"])).toEqual({
    language: "en",
    locale: "en-GB",
  });
  // None it has: English, without a region.
  expect(resolveLanguage("system", ["de-DE", "ja"])).toEqual({ language: "en", locale: "en" });
  expect(resolveLanguage("system", [])).toEqual({ language: "en", locale: "en" });
  // Written as Intl does; a tag it can't read skipped.
  expect(resolveLanguage("en", ["en-us"])).toEqual({ language: "en", locale: "en-US" });
  expect(resolveLanguage("en", ["en-x", "en-AU"])).toEqual({ language: "en", locale: "en-AU" });
});

test("locale() follows the browser on System, so dates do too", () => {
  expect(locale()).toBe("en-US");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR", "en-GB"]);
  expect(locale()).toBe("en-GB");
  setPref("language", "en");
  expect(locale()).toBe("en-GB");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  expect(locale()).toBe("en");
  // Never the machine's own default (`[]`): the page's language.
  expect(new Date(2026, 9, 14).toLocaleDateString(locale())).toBe("10/14/2026");
});

// Types only: `tsc` checks these, the test just keeps them in a function.
test("the catalogs' and t()'s types", () => {
  const types = () => {
    // @ts-expect-error A key missing.
    void ({ "language.name": "Deutsch" } satisfies Catalog);
    const { "shell.settings": _, ...missing } = en;
    // @ts-expect-error The same, the rest there.
    void (missing satisfies Catalog);
    // @ts-expect-error A key too many.
    void ({ ...en, "shell.nowhere": "Nowhere" } satisfies Catalog);
    // @ts-expect-error A plural written as one text.
    void ({ ...en, "review.notes": "notes" } satisfies Catalog);
    // @ts-expect-error A placeholder without its value.
    t("shell.signedIn");
    // @ts-expect-error A value for a placeholder the text hasn't.
    t("shell.signedIn", { login: "octocat" });
    // @ts-expect-error A plural's count is a number.
    t("review.notes", { count: "2" });
    // @ts-expect-error No placeholder, no params.
    t("shell.settings", { count: 1 });
  };
  expect(types).toBeTypeOf("function");
});
