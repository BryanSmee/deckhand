// GitHub's slug of a heading's text, so an anchor is the same on the site as on GitHub: the
// docs link to each other's sections hundreds of times (test/docs-links.test.mjs holds them to
// GitHub's slugs, and this to those). Lower case, without punctuation, spaces as dashes; a
// repeated heading gets -1, -2… from markdown-it-anchor, as on GitHub.
export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}
