// The listener's own small pages (/setup, /auth/*): the dashboard itself needs a session.
import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time comparison of secrets of any length.
export function same(a, b) {
  const digest = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const BASE_CSS = `:root { color-scheme: light dark; --line: #d6d3d1; --accent: #c2410c; --muted: #78716c; }
      body { font: 15px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
      .muted { color: var(--muted); }`;

// `body`: trusted HTML (escape() what isn't). `css`: added to the base style.
export function page(res, status, title, body, { headers = {}, css = "" } = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)} · Deckhand</title>
    <style>
      ${BASE_CSS}${css ? `\n      ${css}` : ""}
    </style>
  </head>
  <body>
    <h1>${escape(title)}</h1>
    ${body}
  </body>
</html>`);
}
