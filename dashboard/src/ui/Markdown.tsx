// An agent's Markdown, as Preact elements: a CommonMark subset (paragraphs, emphasis, code
// spans and blocks, lists, headings, quotes, rules, links) and GFM's tables and strikethrough.
// Never HTML: raw HTML in the text is text, and only http(s) and mailto links become anchors.
// Built for a reply still streaming in: an unclosed fence or a half table renders as it is.
import type { ComponentChildren, JSX } from "preact";
import { useMemo } from "preact/hooks";
import styles from "./Markdown.module.css";

type Align = "left" | "center" | "right" | undefined;

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; loose: boolean; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] };

// A backtick fence's info string has no backtick: ```a``` starts a paragraph with a code span.
const FENCE = /^ {0,3}(`{3,}(?![^`]*`)|~{3,})[ \t]*(\S*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
// Two dashes at least: a lone `-` under a paragraph is a list item still streaming in, not
// an underline turning it into a heading for a moment.
const SETEXT = /^ {0,3}(=+|-{2,})[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const blank = (line: string) => !line.trim();
const indentOf = (line: string) => line.length - line.trimStart().length;

// A table starts at a line with a pipe followed by its delimiter row: a header alone (still
// streaming) is a paragraph until the row comes.
const tableAt = (lines: string[], i: number) =>
  lines[i].includes("|") &&
  i + 1 < lines.length &&
  lines[i + 1].includes("|") &&
  DELIMITER.test(lines[i + 1]);

// A line that ends a paragraph by starting a block of its own. An ordered list only from 1, as
// in CommonMark: "2024. That year…" wrapped onto its own line goes on the paragraph.
const startsBlock = (line: string) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  HR.test(line) ||
  QUOTE.test(line) ||
  /^ *([-*+]|1[.)])( +|$)/.test(line);

// A table row's cells, without its outer pipes; `\|` is a pipe inside a cell.
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parse(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      // To its closing fence, or to the end while it streams in.
      const mark = fence[1];
      const strip = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].trim();
        if (close.startsWith(mark[0].repeat(mark.length)) && !close.replace(/^[`~]+/, "")) break;
        body.push(lines[i].slice(Math.min(strip, indentOf(lines[i]))));
        i++;
      }
      i++;
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) >= 4)) {
        body.push(lines[i].slice(4));
        i++;
      }
      while (body.length && blank(body.at(-1)!)) body.pop();
      blocks.push({ t: "code", lang: "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1].length, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      // Its lines, `>` taken off, and the lazy ones continuing its last paragraph.
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i])) {
        const quoted = QUOTE.exec(lines[i]);
        if (quoted) body.push(quoted[1]);
        else if (startsBlock(lines[i]) || blank(body.at(-1) ?? "")) break;
        else body.push(lines[i]);
        i++;
      }
      blocks.push({ t: "quote", blocks: parse(body) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      i = list(lines, i, blocks);
      continue;
    }
    if (tableAt(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1])
        .slice(0, head.length)
        .map((c): Align => {
          const left = c.startsWith(":");
          const right = c.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : undefined;
        });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push({ t: "table", align, head, rows });
      continue;
    }
    // A paragraph, up to a blank line or a block; a setext underline makes it a heading.
    const body = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i])) {
      const setext = SETEXT.exec(lines[i]);
      if (setext) {
        blocks.push({ t: "h", level: setext[1][0] === "=" ? 1 : 2, text: body.join(" ") });
        body.length = 0;
        i++;
        break;
      }
      if (startsBlock(lines[i]) || tableAt(lines, i)) break;
      body.push(lines[i].trim());
      i++;
    }
    if (body.length) blocks.push({ t: "p", text: body.join("\n") });
  }
  return blocks;
}

// A list from its first item at `i`, onto `blocks`; returns the line after it. A line indented
// past its marker (by more than one space, as agents nest with two) belongs to the item above.
function list(lines: string[], i: number, blocks: Block[]): number {
  const first = ITEM.exec(lines[i])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  // Its bullet, or its numbers' `.` or `)`: another one starts another list.
  const mark = first[2].at(-1);
  const items: Block[][] = [];
  let loose = false;
  const sibling = (line: string) => {
    const m = ITEM.exec(line);
    return (
      !!m &&
      !HR.test(line) &&
      /\d/.test(m[2]) === ordered &&
      m[2].at(-1) === mark &&
      m[1].length >= indent &&
      m[1].length <= indent + 1
    );
  };
  while (i < lines.length && sibling(lines[i])) {
    const m = ITEM.exec(lines[i])!;
    const content = indent + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        let j = i;
        while (j < lines.length && blank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > indent + 1) {
          body.push(...lines.slice(i, j).map(() => ""));
          loose = true;
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(line);
      if (ind > indent + 1) body.push(line.slice(Math.min(ind, content)));
      else if (!blank(body.at(-1)!) && !startsBlock(line) && !ITEM.test(line))
        body.push(line.trim());
      else break;
      i++;
    }
    items.push(parse(body));
    let j = i;
    while (j < lines.length && blank(lines[j])) j++;
    if (j > i && j < lines.length && sibling(lines[j])) {
      loose = true;
      i = j;
    }
  }
  blocks.push({ t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, loose, items });
  return i;
}

// Only these become anchors: `javascript:`, `data:` and relative paths stay text.
const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

// A link's `[label](url "title")` from the `[` at `i`: its label, URL and the index after it.
function linkAt(s: string, i: number): { label: string; url: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const label = s.slice(i + 1, j);
  let k = j + 2;
  while (s[k] === " ") k++;
  let url = "";
  if (s[k] === "<") {
    const close = s.indexOf(">", k);
    if (close < 0) return null;
    url = s.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const from = k;
    for (; k < s.length && !/\s/.test(s[k]); k++) {
      if (s[k] === "(") parens++;
      else if (s[k] === ")" && parens-- === 0) break;
    }
    url = s.slice(from, k);
  }
  const title = /^\s+("[^"]*"|'[^']*'|\([^)]*\))\s*/.exec(s.slice(k));
  if (title) k += title[0].length;
  while (s[k] === " ") k++;
  if (s[k] !== ")") return null;
  return { label, url, end: k + 1 };
}

const anchor = (url: string, children: ComponentChildren, key: number) => (
  <a key={key} href={url} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

// A closing run of exactly `n` of `c` after `from`, not after a space; code spans skipped. With
// `longer`, a longer run's last `n` close too: `**bold *it***` ends both at once.
function closerAt(s: string, from: number, c: string, n: number, longer = false): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "`") {
      const run = /^`+/.exec(s.slice(j))![0];
      const close = s.indexOf(run, j + run.length);
      if (close > 0) j = close + run.length - 1;
    } else if (s[j] === c) {
      let k = j;
      while (s[k] === c) k++;
      const after = s[k] ?? "";
      const fits = k - j === n || (longer && k - j > n);
      if (fits && !/\s/.test(s[j - 1]) && j > from && !(c === "_" && WORD.test(after)))
        return k - n;
      j = k - 1;
    }
  }
  return -1;
}

const EMPHASIS: Record<number, (c: ComponentChildren, key: number) => JSX.Element> = {
  1: (c, key) => <em key={key}>{c}</em>,
  2: (c, key) => <strong key={key}>{c}</strong>,
  3: (c, key) => (
    <strong key={key}>
      <em>{c}</em>
    </strong>
  ),
};

// Without `links`, for a link's label: an anchor never holds another.
function inline(s: string, links = true): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let text = "";
  const push = (node: ComponentChildren) => {
    if (text) out.push(text);
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === "\\" && PUNCT.test(s[i + 1] ?? "")) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      // A line break where the agent wrote one, as GitHub's comments show them.
      push(<br key={i} />);
      i++;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      let close = s.indexOf(run, i + run.length);
      while (close > 0 && s[close + run.length] === "`")
        close = s.indexOf(run, close + run.length + 1);
      if (close > 0) {
        let code = s.slice(i + run.length, close).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        push(<code key={i}>{code}</code>);
        i = close + run.length;
      } else {
        text += run;
        i += run.length;
      }
      continue;
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const image = c === "!";
      const link = linkAt(s, image ? i + 1 : i);
      if (link) {
        const raw = s.slice(i, link.end);
        // In a label (a badge's `[![alt](…)](…)`): its text alone.
        if (!links) push(image ? link.label : inline(link.label, false));
        // An image is a link to it: the dashboard doesn't load what a reply points at.
        else if (SAFE_URL.test(link.url))
          push(anchor(link.url, image ? link.label || link.url : inline(link.label, false), i));
        else text += raw;
        i = link.end;
        continue;
      }
    }
    if (c === "<" && links) {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (auto) {
        push(anchor(auto[1], auto[1], i));
        i += auto[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && links && !WORD.test(s[i - 1] ?? "")) {
      const bare = /^https?:\/\/[^\s<>]+/i.exec(rest);
      if (bare) {
        // Not the sentence's punctuation after it, nor a closing paren it didn't open.
        let url = bare[0].replace(/[.,;:!?'"*_~]+$/, "");
        while (url.endsWith(")") && url.split("(").length < url.split(")").length)
          url = url.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, "");
        push(anchor(url, url, i));
        i += url.length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const run = new RegExp(`^\\${c}+`).exec(rest)![0];
      const n = c === "~" ? (run.length === 2 ? 2 : 0) : Math.min(run.length, 3);
      const intraword = c === "_" && WORD.test(s[i - 1] ?? "");
      const opens = n > 0 && run.length === n && !intraword && !/\s/.test(s[i + n] ?? " ");
      // A run of its own length first, so `*a **b** c*` closes at its last `*`.
      const exact = opens ? closerAt(s, i + n, c, n) : -1;
      const close = exact > 0 || !opens ? exact : closerAt(s, i + n, c, n, true);
      if (close > 0) {
        const inner = inline(s.slice(i + n, close), links);
        push(c === "~" ? <del key={i}>{inner}</del> : EMPHASIS[n](inner, i));
        i = close + n;
      } else {
        text += run;
        i += run.length;
      }
      continue;
    }
    text += c;
    i++;
  }
  if (text) out.push(text);
  return out;
}

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function render(block: Block, key: number, tight = false): ComponentChildren {
  switch (block.t) {
    case "p":
      return tight ? inline(block.text) : <p key={key}>{inline(block.text)}</p>;
    case "h": {
      const H = HEADINGS[block.level - 1];
      return <H key={key}>{inline(block.text)}</H>;
    }
    case "code":
      return (
        <pre key={key} class={styles.code} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{block.blocks.map((b, k) => render(b, k))}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "list": {
      const items = block.items.map((item, k) => (
        <li key={k}>{item.map((b, n) => render(b, n, !block.loose))}</li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table": {
      // Every row as wide as the header: a short one padded, a long one cut.
      const row = (cols: string[], Cell: "th" | "td") =>
        block.head.map((_, k) => (
          <Cell key={k} style={block.align[k] ? { textAlign: block.align[k] } : undefined}>
            {inline(cols[k] ?? "")}
          </Cell>
        ));
      return (
        <div key={key} class={styles.table}>
          <table>
            <thead>
              <tr>{row(block.head, "th")}</tr>
            </thead>
            {block.rows.length > 0 && (
              <tbody>
                {block.rows.map((r, k) => (
                  <tr key={k}>{row(r, "td")}</tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    }
  }
}

export function Markdown({ text, class: className }: { text: string; class?: string }) {
  const blocks = useMemo(
    () => parse(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")),
    [text],
  );
  return (
    <div class={[styles.markdown, className].filter(Boolean).join(" ")}>
      {blocks.map((b, k) => render(b, k))}
    </div>
  );
}
