// The dashboard's languages: a catalog each, typed from the English one (en.ts). Another
// catalog is written `export const fr = { … } satisfies Catalog`: a key missing or one too many
// fails `tsc`, and so `npm run build`. Adding a language is its catalog here and its code in
// public/theme.js's list (a spec keeps the two in step): docs/dashboard-languages.md.
import { en } from "./en";
import { fr } from "./fr";

// One text per plural form the language has (Intl.PluralRules), `other` always.
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

export type Source = typeof en;
export type Key = keyof Source;
export type Catalog = { [K in Key]: Source[K] extends string ? string : Plural };
// A catalog's part in a file of its own (fr-board.ts), checked against the English file's keys
// (en-board.ts): `satisfies Section<typeof board>`.
export type Section<T> = { [K in keyof T & Key]: Catalog[K] };

// The names in a text's placeholders ("{n}s ago" has "n"), a plural's count among them.
type Names<S> = S extends `${string}{${infer N}}${infer R}` ? N | Names<R> : never;
export type Holes<E> = E extends string ? Names<E> : "count" | Names<E[keyof E] & string>;
// The keys whose text has no placeholder: what a label kept as a key can be.
export type Plain = { [K in Key]: [Holes<Source[K]>] extends [never] ? K : never }[Key];

export const CATALOGS = { en, fr } satisfies Record<string, Catalog>;

export type Language = keyof typeof CATALOGS;
export const LANGUAGES = Object.keys(CATALOGS) as Language[];

// The browser's languages, most wanted first (none where a page stubs navigator).
export const browserLanguages = (): readonly string[] => globalThis.navigator?.languages ?? [];

// The language a choice comes to, and the locale its dates and numbers are written in: the
// first of the browser's languages (navigator.languages) that it has a catalog for, with its
// region ("en-GB": British dates in English). An explicit choice keeps the region the browser
// gives it, if any. Nothing matches: English, or the choice as it is.
export function resolveLanguage(
  choice: Language | "system",
  preferred: readonly string[],
  languages: readonly string[] = LANGUAGES,
): { language: Language; locale: string } {
  const wanted = choice === "system" ? languages : [choice];
  for (const tag of preferred) {
    const primary = tag.split("-")[0].toLowerCase();
    if (!wanted.includes(primary)) continue;
    try {
      // A tag Intl can't read would throw in every date it writes: skipped.
      return { language: primary as Language, locale: Intl.getCanonicalLocales(tag)[0] };
    } catch {
      continue;
    }
  }
  const language = choice === "system" ? "en" : choice;
  return { language, locale: language };
}
