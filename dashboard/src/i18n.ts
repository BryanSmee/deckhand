// The dashboard's texts in the language Settings › Preferences › Language picks (prefs.ts),
// from its catalog (locales/). t() writes a key's text, its `{name}` placeholders filled and its
// plural picked by Intl.PluralRules; tx() does the same with elements in the placeholders. Both
// read the choice when called: a change re-renders the page (App.tsx reads every pref through
// usePref), and so writes it again. Dates and numbers take locale().
import { type ComponentChildren, createElement, Fragment, type VNode } from "preact";
import {
  CATALOGS,
  type Catalog,
  type Holes,
  type Key,
  type Language,
  type Plural,
  browserLanguages,
  resolveLanguage,
  type Source,
} from "./locales";
import { getPref } from "./prefs";

// A plural's count is a number: it picks the form.
type Params<K extends Key, V> = Source[K] extends string
  ? Record<Holes<Source[K]>, V>
  : Record<Exclude<Holes<Source[K]>, "count">, V> & { count: number };
// No placeholder, no params.
type Args<K extends Key, V> = [Holes<Source[K]>] extends [never] ? [] : [params: Params<K, V>];

let last: { choice: string; preferred: string; at: ReturnType<typeof resolveLanguage> } | null =
  null;

// The language and locale now: resolved once per choice and browser languages.
function current() {
  const choice = getPref("language");
  const preferred = browserLanguages().join();
  if (last?.choice !== choice || last.preferred !== preferred)
    last = { choice, preferred, at: resolveLanguage(choice, browserLanguages()) };
  return last.at;
}

export const language = (): Language => current().language;

// The BCP 47 locale every date and number is written in ("en-GB"): never the browser's own
// default, which may not be the page's language.
export const locale = (): string => current().locale;

const numbers = new Map<string, Intl.NumberFormat>();
const plurals = new Map<string, Intl.PluralRules>();
const cached = <T>(map: Map<string, T>, at: string, make: () => T) => {
  if (!map.has(at)) map.set(at, make());
  return map.get(at)!;
};

// A number as the locale writes it: "1,234", "1 234".
export const number = (n: number) =>
  cached(numbers, locale(), () => new Intl.NumberFormat(locale())).format(n);

// The text of `key` in `catalog`, its plural form picked for `count`. A catalog type-checks
// against the English one, so the fallback only covers a catalog built some other way.
export function pick(catalog: Catalog, key: Key, count: number | undefined, at: string): string {
  const entry: string | Plural = catalog[key] ?? CATALOGS.en[key];
  if (typeof entry === "string") return entry;
  const form = cached(plurals, at, () => new Intl.PluralRules(at)).select(count ?? 0);
  return entry[form] ?? entry.other;
}

// The text's pieces: its own, and each placeholder's value (numbers written in the locale, but
// an issue's or pull request's after a `#`: "#1234", never "#1,234").
function fill<V>(text: string, params: Record<string, V> | undefined): (string | V)[] {
  const pieces = text.split(/\{(\w+)\}/);
  return pieces.map((piece, i) => {
    if (i % 2 === 0) return piece;
    const value = params?.[piece];
    if (value === undefined) return `{${piece}}`;
    if (typeof value !== "number") return value;
    return pieces[i - 1].endsWith("#") ? String(value) : number(value);
  });
}

function parts<V>(key: Key, params: Record<string, V> | undefined): (string | V)[] {
  const { language: lang, locale: at } = current();
  const count = params?.count;
  return fill(pick(CATALOGS[lang], key, typeof count === "number" ? count : undefined, at), params);
}

// "3 queued", "1 repository needs you".
export function t<K extends Key>(key: K, ...[params]: Args<K, string | number>): string {
  return parts<string | number>(key, params).join("");
}

// The same, elements in its placeholders: "Single keys, like <kbd>/</kbd> to search…".
export function tx<K extends Key>(key: K, ...[params]: Args<K, ComponentChildren>): VNode {
  return createElement(Fragment, null, ...parts<ComponentChildren>(key, params));
}

// "a, b and c": a list joined as the language does.
export function and(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return t("list.and", {
    first: items.slice(0, -1).join(t("list.comma")),
    last: items.at(-1)!,
  });
}
