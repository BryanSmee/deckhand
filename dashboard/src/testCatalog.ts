// A test catalog where every text of the dashboard's own is marked (⟦…⟧), each piece between
// its placeholders on its own, so what a placeholder brings (a repository, a count) stays
// outside: a page rendered in it shows, through unmarked(), the English it still writes
// inline. A spec mocks ./locales with withMarked() and picks the language with useMarked():
//
//   vi.mock("./locales", async (original) =>
//     (await import("./testCatalog")).withMarked(await original()),
//   );
import type * as Locales from "./locales";

export const MARKED = "xx";

const mark = (text: string) =>
  text
    .split(/(\{\w+\})/)
    .map((piece, i) => (i % 2 || !piece ? piece : `⟦${piece}⟧`))
    .join("");

// The real module with a marked catalog beside English.
export function withMarked(real: typeof Locales): typeof Locales {
  const marked = Object.fromEntries(
    Object.entries(real.CATALOGS.en).map(([key, text]) => [
      key,
      typeof text === "string"
        ? mark(text)
        : Object.fromEntries(Object.entries(text).map(([form, t]) => [form, mark(t)])),
    ]),
  ) as unknown as (typeof real.CATALOGS)["en"];
  const CATALOGS = { ...real.CATALOGS, [MARKED]: marked };
  const LANGUAGES = Object.keys(CATALOGS) as Locales.Language[];
  return {
    ...real,
    CATALOGS,
    LANGUAGES,
    resolveLanguage: (choice, preferred) => real.resolveLanguage(choice, preferred, LANGUAGES),
  };
}

// Before the page renders (prefs.ts would import the mocked module back: kept as it does).
export const useMarked = () => localStorage.setItem("deckhand.language", MARKED);

// Code, keys and what is shown as it is: never translated.
const VERBATIM = "script, style, code, kbd, pre, samp";
const ATTRIBUTES = ["aria-label", "aria-description", "title", "placeholder", "alt"];

// The texts under `root` (its text, and the attributes a user reads or hears) that still hold
// a word outside the marks, once `data` is taken out: what the page shows of its own (task
// titles, repositories, names, keys) isn't the dashboard's to translate, nor are identifiers
// (`allow_run`, `.deckhand/policy/`).
export function unmarked(root: Element, data: readonly string[] = []): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    if (node instanceof Text) {
      if (!node.parentElement?.closest(VERBATIM)) texts.push(node.data);
    } else if (node instanceof Element)
      for (const name of ATTRIBUTES) {
        const value = node.getAttribute(name);
        if (value) texts.push(value);
      }
  }
  // Identifiers too (rule names, files, paths, addresses), in the data as in the page.
  const verbatim = (text: string) => text.replace(/[\w.:-]*(?:[_/]|\.\w)[\w.:/-]*/g, " ");
  const longest = data.map(verbatim).sort((a, b) => b.length - a.length);
  return texts.filter((text) => {
    let rest = verbatim(text.replace(/⟦[^⟧]*⟧/g, " "));
    for (const d of longest) if (d.trim()) rest = rest.split(d).join(" ");
    return /\p{L}{2,}/u.test(rest);
  });
}
