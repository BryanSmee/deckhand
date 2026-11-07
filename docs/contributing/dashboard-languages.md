# The dashboard's languages

The dashboard speaks English and French. Each user picks theirs in Settings › Preferences ›
Language. **System**, the default, takes the first of the browser's languages that has a
catalog, and English when none does. Dates and numbers follow the language picked, written with
the browser's region for it: `fr-CA` gets Canadian French dates, `fr` alone gets France's.

This page is for adding a language, and for keeping one up to date.

## Where the texts are

Every text the dashboard writes itself comes from a catalog in `dashboard/src/locales/`:

- `en.ts` is the source. The other catalogs are checked against it. It holds the shared texts
  (states, times, the shell, Preferences) and spreads in one file per area (`en-board.ts`,
  `en-detail.ts`, `en-policies.ts`…).
- `fr.ts` and its `fr-<area>.ts` files are the French catalog. Each French file mirrors its
  English one, key for key.
- `index.ts` lists the catalogs (`CATALOGS`) and resolves a choice to a language and a locale.
- `src/i18n.ts` has `t()` and `tx()`, which components call with a key. It also has the number,
  list and date helpers, which write in the page's locale.

A text can have placeholders (`{repo}`, `{count}`). A text that depends on a number is a
plural: one text per form the language has (`one`, `other`, and `zero`, `two`, `few`, `many`
where a language has them, as `Intl.PluralRules` names them).

## Adding a language

Take German (`de`) as the example.

1. **The catalog.** Copy `fr.ts` and the `fr-*.ts` files to `de.ts` and `de-*.ts`, then
   translate every text from the English one. Each area file ends with
   `satisfies Section<typeof en>` (`en` being the English area it mirrors), and `de.ts` ends
   with `satisfies Catalog`. A key missing, a key too many, or a plural written as a single
   text fails `tsc`, so it also fails `npm run build`.
2. **Its own name.** `"language.name"` is the language's name in that language (`"Deutsch"`):
   Preferences lists every language by its own name, so a user who can't read the page can still
   find theirs.
3. **The list.** Add the catalog to `CATALOGS` in `locales/index.ts`, and its code to
   `LANGUAGES` in `dashboard/public/theme.js`. That script sets the page's `lang` before the
   first paint. `Preferences.spec.tsx` fails when the two lists differ.
4. **Plurals and ordinals.** Write the plural forms the language has, and no other:
   `new Intl.PluralRules("de").resolvedOptions().pluralCategories` lists them. The board's
   ordinals ("1st", "2nd") are one key per ordinal form (`graph.ordinalOne`…
   `graph.ordinalOther`). Fill in the forms that
   `new Intl.PluralRules("de", { type: "ordinal" })` gives. `locales.spec.ts` checks both.
5. **Placeholders.** Keep every placeholder of the English text, with the same names, in
   whatever order the sentence needs. Keep `#{number}` together: an issue's or pull request's
   number is written as GitHub writes it (`#1234`), never grouped (`#1 234`).
   `locales.spec.ts` fails on a placeholder that is missing or renamed.
6. **Typography.** Follow the language's own typography. French has a no-break space before
   `:` and a narrow no-break space before `?` `!` `;`, written as the characters themselves,
   so a line never breaks before them. It also uses `’` for apostrophes. `locales.spec.ts`
   checks French for these. Give a new language's own rules a test there too.
7. **The checks.** Run `npm test && npm run build` in `dashboard/`.

## What isn't translated

- **What the dashboard shows but didn't write.** That covers GitHub's content (issue and pull
  request titles, comments, labels) and the agents' (run logs, questions, chat messages,
  results).
- **Names.** Repositories, modes, capabilities, policy rules, settings and file names, keyboard
  keys, and the services' names.
- **The server's texts.** The API's error messages, refusal reasons and a task's notes are
  written in `listener/` and `edge/`, in English, and shown as the server sends them (#720).
- **The tests.** The specs query the page by its English texts, and `vitest.setup.ts` pins
  English, so they don't change when a language is added.

## Checking the longest texts

A translation is often longer than its English text, and some places have little room:
segmented controls (Preferences, the board's Graph and Lanes), chips (states, the task list's
filters), buttons, tabs, and the phone's bottom bar. Before you open the pull request:

- Pick the language in Preferences, then look at the Overview, the board, a task's detail (one
  with open questions, one with a pull request) and Preferences. Check each at 1440 px and
  390 px wide, in light and dark themes.
- Look for text that is cut off, wraps where it shouldn't, or pushes a row past the screen. A
  row of chips or tabs that scrolls sideways is fine: it does that in English too.
- When a text doesn't fit, shorten the translation first. Change the CSS only when no shorter
  wording reads well, and check English again after you do.

Add screenshots of those pages, in the new language, to the pull request.

## Keeping a language up to date

A new English key fails `tsc` until every catalog has it. So whoever adds a text to the
dashboard adds its translation in the same pull request, or asks for one in it. A changed
English text has no such check: when its meaning changes, update the other catalogs too.
