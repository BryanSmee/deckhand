// Every catalog beside English (locales/), what `tsc` can't check: a text keeps its English
// placeholders, `#{number}` together, and a plural only the forms its language has. Then French
// itself: its plurals, numbers and dates, and its spaces before `:` `?` `!` `;`, which never
// break a line.
import { expect, test, vi } from "vitest";
import { number, t } from "./i18n";
import { type Catalog, CATALOGS, type Key, LANGUAGES } from "./locales";
import { setPref } from "./prefs";

const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const texts = (entry: Catalog[Key]) => (typeof entry === "string" ? [entry] : Object.values(entry));
const others = LANGUAGES.filter((code) => code !== "en");

test.each(others)("%s: every text with the English one's placeholders", (code) => {
  const catalog: Catalog = CATALOGS[code];
  const wrong = (Object.keys(CATALOGS.en) as Key[]).filter((key) => {
    const source = texts(CATALOGS.en[key]);
    // A plural's count may show in one language and not another ("{what} findings").
    const plural = typeof CATALOGS.en[key] !== "string";
    const wanted = new Set(source.flatMap(holes).filter((name) => !plural || name !== "count"));
    const glued = source.some((text) => text.includes("#{"));
    return texts(catalog[key]).some((text) => {
      const own = new Set(holes(text));
      if (plural) own.delete("count");
      return (
        [...own].some((name) => !wanted.has(name)) ||
        [...wanted].some((name) => !own.has(name)) ||
        (glued && !text.includes("#{"))
      );
    });
  });
  expect(wrong).toEqual([]);
});

test.each(others)("%s: a plural has only the forms its language has, other among them", (code) => {
  const forms = new Set<string>(new Intl.PluralRules(code).resolvedOptions().pluralCategories);
  const ordinals = new Set<string>(
    new Intl.PluralRules(code, { type: "ordinal" }).resolvedOptions().pluralCategories,
  );
  const catalog: Catalog = CATALOGS[code];
  const wrong = Object.entries(catalog).filter(
    ([, entry]) =>
      typeof entry !== "string" &&
      (!("other" in entry) || Object.keys(entry).some((form) => !forms.has(form))),
  );
  expect(wrong).toEqual([]);
  // The ordinals are a key per form (graphModel.ts ordinal()): each form the language has, filled.
  for (const form of ordinals) expect(catalog[ordinalKey(form)]).toBeTruthy();
});

const ordinalKey = (form: string) => `graph.ordinal${form[0].toUpperCase()}${form.slice(1)}` as Key;

test("French: a space before : ? ! ; that never breaks, typographic apostrophes", () => {
  const wrong = Object.entries(CATALOGS.fr).filter(([, entry]) =>
    texts(entry).some((text) => / [:?!;»]|« |'/.test(text)),
  );
  expect(wrong).toEqual([]);
});

test("French: plurals, numbers and dates", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR", "en-US"]);
  expect(t("shell.settings")).toBe("Paramètres");
  // One covers 0 and 1.
  expect([0, 1, 2].map((count) => t("review.notes", { count }))).toEqual([
    "0 note",
    "1 note",
    "2 notes",
  ]);
  expect(number(1234567)).toBe("1 234 567");
  expect(t("shell.repoRunning", { repo: "acme/app", count: 1234 })).toBe(
    "acme/app : 1 234 en cours",
  );
  expect(t("repos.issueState", { number: 1234, state: "open" })).toMatch(/#1234\b/);
  // A choice of English stays English on a French browser.
  setPref("language", "en");
  expect(t("shell.settings")).toBe("Settings");
});
