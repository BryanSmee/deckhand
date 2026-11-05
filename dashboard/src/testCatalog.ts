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

// What a text under `root` says (its text nodes, and the attributes a user reads or hears), with
// the element it is on.
function texts(root: Element): { text: string; on: Element }[] {
  const found: { text: string; on: Element }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    if (node instanceof Text) {
      const on = node.parentElement;
      if (on && !on.closest(VERBATIM)) found.push({ text: node.data, on });
    } else if (node instanceof Element)
      for (const name of ATTRIBUTES) {
        const value = node.getAttribute(name);
        if (value) found.push({ text: value, on: node });
      }
  }
  return found;
}

// Identifiers (rule names, files, paths, addresses), in the data as in the page.
const verbatim = (text: string) => text.replace(/[\w.:-]*(?:[_/]|\.\w)[\w.:/-]*/g, " ");

// A text's parts between the marks and the punctuation that joins what the page shows ("acme/app ·
// #12", "(Ctrl Shift C)"): each is the dashboard's own unless it is data as a whole.
export const parts = (text: string) =>
  verbatim(text)
    .split(/⟦[^⟧]*⟧|\{\w+\}|[·,;:()[\]“”"…—–|+]+/)
    .map((part) => part.trim())
    .filter((part) => /\p{L}{2,}/u.test(part));

// The texts under `root` that still hold a word outside the marks: a part that is neither a
// whole piece of `data` (what the page was given: task titles, repositories, what the API
// answered) nor made of `names` alone (keys, product names, what the browser writes of a
// date). Identifiers (`allow_run`, `.deckhand/policy/`) aren't the dashboard's to translate
// either. `within` gives more data, taken only under the elements a selector matches.
export function unmarked(
  root: Element,
  {
    data = [],
    names = [],
    within = {},
  }: {
    data?: readonly string[];
    names?: readonly string[];
    within?: Record<string, readonly string[]>;
  } = {},
): string[] {
  const given = new Set(data.flatMap(parts));
  const named = new Set(names);
  const isName = (part: string) =>
    part.split(/\s+/).every((word) => named.has(word) || !/\p{L}/u.test(word));
  return texts(root)
    .filter(({ text, on }) => {
      const scoped = new Set(
        Object.entries(within).flatMap(([selector, more]) =>
          on.closest(selector) ? more.flatMap(parts) : [],
        ),
      );
      return parts(text).some((part) => !given.has(part) && !scoped.has(part) && !isName(part));
    })
    .map(({ text }) => text);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The texts under `root` that show one of `keys` as it is: a key passed on where its text
// was meant (unmarked() takes it for an identifier).
export const keysShown = (root: Element, keys: readonly string[]): string[] =>
  texts(root)
    .map(({ text }) => text)
    .filter((text) =>
      keys.some((key) => new RegExp(`(?<![\\w.])${escape(key)}(?![\\w.])`).test(text)),
    );
