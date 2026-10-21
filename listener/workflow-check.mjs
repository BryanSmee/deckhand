// The checks the git gateway runs on the workflow files a push of a repo granted
// `allow_workflows` changes (git-gateway.mjs): a workflow a sandbox wrote must cap its token
// at read and name no secret, since GitHub runs a branch's own workflows on push and
// pull_request.
//
// The listener has no dependencies, so it reads them with its own parser. Not yaml.mjs's: a
// config the default branch owns can be read loosely (JSON escapes, typed scalars, `...`
// ending the file), a file a sandbox wrote can't: this one decodes every escape GitHub does
// and refuses the rest. A strict subset of YAML: block mappings and sequences, plain, quoted
// and block scalars, flow collections on one line. Anything else (anchors, aliases, tags,
// merge keys, several documents, duplicate keys, multi-line flow scalars…) is refused rather
// than guessed at, so the checks never read a file differently from GitHub. Only a space or a
// tab separates, as in YAML: never JS's `\s`, which also matches NBSP and other Unicode spaces
// YAML reads as text. Line breaks other than \n and \r\n are refused.

export class YamlError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
  }
}

// YAML's whitespace, and nothing else.
const strip = (text) => text.replace(/^[ \t]+|[ \t]+$/g, "");
const stripEnd = (text) => text.replace(/[ \t]+$/, "");
// Keys compared without case, with the folds GitHub's case-insensitive matching may make
// (`ſ` is an `S` once in upper case).
const fold = (text) => text.toUpperCase().toLowerCase();
// Line breaks YAML 1.1 parsers know besides \n (NEL, LS, PS, a lone CR), control characters
// and a BOM past the start: refused, so no line reads differently there and here.
const REFUSED_CHARACTERS = /[\0-\x08\x0b\x0c\r\x0e-\x1f\x7f\x85\u2028\u2029\ufeff]/;

// Characters a plain scalar or key can't start with, in this subset.
const INDICATORS = new Set([..."&*!|>%@`?,[]{}#"]);

const ESCAPES = {
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: " ",
  P: " ",
};
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

// A quoted scalar starting at text[start]: { value, end } with `end` just past its closing
// quote. It must close on its line.
function quoted(text, start, line) {
  const quote = text[start];
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c !== "'") value += c;
      else if (text[i + 1] === "'") ((value += "'"), i++);
      else return { value, end: i + 1 };
    } else if (c === '"') {
      return { value, end: i + 1 };
    } else if (c === "\\") {
      const e = text[++i];
      if (e in HEX_ESCAPES) {
        const hex = text.slice(i + 1, i + 1 + HEX_ESCAPES[e]);
        const code = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : NaN;
        if (hex.length !== HEX_ESCAPES[e] || !(code <= 0x10ffff)) {
          throw new YamlError(line, `bad escape \\${e}${hex}`);
        }
        value += String.fromCodePoint(code);
        i += HEX_ESCAPES[e];
      } else if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
        value += ESCAPES[e];
      } else {
        throw new YamlError(line, `bad escape \\${e ?? ""}`);
      }
    } else {
      value += c;
    }
  }
  throw new YamlError(line, "quoted scalars must close on their line");
}

// What may follow a value on its line: spaces, then a comment.
function trailing(text, end, line) {
  const rest = text.slice(end);
  if (strip(rest) && !/^[ \t]+#/.test(rest)) {
    throw new YamlError(line, `unexpected \`${strip(rest)}\` after a value`);
  }
}

// A plain scalar on its own, its comment removed.
function plain(text, line) {
  const comment = /[ \t]#/.exec(text);
  const value = strip(comment ? text.slice(0, comment.index) : text);
  if (INDICATORS.has(value[0]) || /^-([ \t]|$)/.test(value)) {
    throw new YamlError(line, `unsupported YAML: \`${value[0]}\` (anchors, aliases, tags…)`);
  }
  if (/:([ \t]|$)/.test(value)) throw new YamlError(line, "a mapping isn't allowed here");
  return value;
}

export function parseYaml(text, onScalar = () => {}) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  // The text's last newline ends its last line: no empty one after it.
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((raw, n) => {
    const bad = REFUSED_CHARACTERS.exec(raw);
    if (bad) {
      const code = bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      throw new YamlError(n + 1, `unsupported character U+${code}`);
    }
  });
  // Lines read from the middle: a sequence item's content ("- key: value"), as if it started
  // its own line at its column.
  const inline = new Map();
  let i = 0;

  const scalar = (value, line) => (onScalar(value, line), value);

  // The next line with content, as { indent, text, line }, or null at the end. Comments and
  // blank lines are skipped.
  function peek() {
    for (; i < lines.length; i++) {
      if (inline.has(i)) return inline.get(i);
      const raw = lines[i];
      if (/^[ \t]*(#.*)?$/.test(raw)) continue;
      const indent = /^ */.exec(raw)[0].length;
      if (raw[indent] === "\t") throw new YamlError(i + 1, "tabs can't indent YAML");
      const text = stripEnd(raw.slice(indent));
      if (indent === 0 && /^(---|\.\.\.)([ \t]|$)/.test(text)) {
        throw new YamlError(i + 1, "several documents aren't supported");
      }
      return { indent, text, line: i + 1 };
    }
    return null;
  }

  function next() {
    inline.delete(i);
    i++;
  }

  const isItem = (text) => /^-([ \t]|$)/.test(text);

  // A mapping entry's key and what follows its colon, or null when the text isn't one.
  function entry(text, line) {
    let key, rest;
    if (text[0] === '"' || text[0] === "'") {
      const q = quoted(text, 0, line);
      const colon = /^[ \t]*:([ \t]|$)/.exec(text.slice(q.end));
      if (!colon) return null;
      key = q.value;
      rest = text.slice(q.end + colon[0].length);
    } else {
      if (text[0] === "[" || text[0] === "{") return null;
      const colon = /:([ \t]|$)/.exec(text);
      const comment = /[ \t]#/.exec(text);
      if (!colon || (comment && comment.index < colon.index)) return null;
      key = stripEnd(text.slice(0, colon.index));
      rest = text.slice(colon.index + colon[0].length);
      if (!key || INDICATORS.has(key[0]) || key[0] === "-") {
        throw new YamlError(line, `unsupported key \`${key}\` (anchors, aliases, tags…)`);
      }
      if (key === "<<") throw new YamlError(line, "merge keys (`<<`) aren't supported");
    }
    return { key, rest: strip(rest) };
  }

  // The node below a line at `parent`'s indent: more indented, or a sequence at the same
  // indent when `sameIndentSequence` (a mapping's value). Empty: "".
  function node(parent, sameIndentSequence = false) {
    const first = peek();
    if (!first) return "";
    if (
      first.indent < parent ||
      (first.indent === parent && !(sameIndentSequence && isItem(first.text)))
    ) {
      return "";
    }
    if (isItem(first.text)) return sequence(first.indent);
    if (entry(first.text, first.line)) return mapping(first.indent);
    next();
    return value(first.text, parent, first.line);
  }

  function mapping(indent) {
    const map = new Map();
    const keys = new Set();
    for (let line = peek(); line && line.indent >= indent; line = peek()) {
      if (line.indent > indent) throw new YamlError(line.line, "unexpected indentation");
      if (isItem(line.text)) throw new YamlError(line.line, "a sequence item isn't allowed here");
      const found = entry(line.text, line.line);
      if (!found) throw new YamlError(line.line, "expected `key: value`");
      // Without case: GitHub's keys are, some of them, and a near-duplicate is never needed.
      if (keys.has(fold(found.key))) {
        throw new YamlError(line.line, `duplicate key \`${found.key}\``);
      }
      keys.add(fold(found.key));
      scalar(found.key, line.line);
      next();
      map.set(found.key, value(found.rest, indent, line.line, true));
    }
    return map;
  }

  function sequence(indent) {
    const list = [];
    for (let line = peek(); line && line.indent >= indent; line = peek()) {
      if (line.indent > indent) throw new YamlError(line.line, "unexpected indentation");
      if (!isItem(line.text)) break;
      const after = line.text.slice(1);
      const content = after.replace(/^[ \t]+/, "");
      if (!content || content[0] === "#") {
        next();
        list.push(node(indent));
      } else if (isItem(content) || entry(content, line.line)) {
        // "- key: value" or "- - x": read as a line of its own at the content's column.
        inline.set(i, {
          indent: indent + 1 + after.length - content.length,
          text: content,
          line: line.line,
        });
        list.push(node(indent));
      } else {
        next();
        list.push(value(content, indent, line.line));
      }
    }
    return list;
  }

  // The value after a key's colon or an item's dash, on a line of a node at `indent`.
  function value(text, indent, line, ofMapping = false) {
    if (!text || text[0] === "#") return node(indent, ofMapping);
    let result;
    if (text[0] === "|" || text[0] === ">") return block(text, indent, line);
    if (text[0] === '"' || text[0] === "'") {
      const q = quoted(text, 0, line);
      trailing(text, q.end, line);
      result = scalar(q.value, line);
    } else if (text[0] === "[" || text[0] === "{") {
      const f = flow(text, 0, line);
      trailing(text, f.end, line);
      result = f.value;
    } else {
      result = scalar(plain(text, line), line);
    }
    const after = peek();
    if (after && after.indent > indent) {
      throw new YamlError(after.line, "multi-line scalars aren't supported: use `|` or `>`");
    }
    return result;
  }

  // A block scalar (`|`, `>`), its header in `header`, its content the lines below, more
  // indented than `indent`.
  function block(header, indent, line) {
    const h =
      /^([|>])([1-9])?([+-])?([ \t]+#.*)?$/.exec(header) ??
      /^([|>])([+-])([1-9])([ \t]+#.*)?$/.exec(header);
    if (!h) throw new YamlError(line, `unsupported block scalar header \`${header}\``);
    const [, style] = h;
    const flags = (h[2] ?? "") + (h[3] ?? "");
    const digit = /[1-9]/.exec(flags)?.[0];
    const chomp = /[+-]/.exec(flags)?.[0] ?? "";
    let column = digit ? indent + Number(digit) : null;
    const body = [];
    for (; i < lines.length; i++) {
      const raw = lines[i];
      const spaces = /^ */.exec(raw)[0].length;
      if (!strip(raw)) {
        body.push(column !== null && spaces > column ? raw.slice(column) : "");
        continue;
      }
      if (column === null) column = spaces;
      if (column <= indent || spaces < column) break;
      body.push(raw.slice(column));
    }
    // Trailing blank lines past the block belong to what follows, but chomping counts them.
    let end = body.length;
    while (end > 0 && body[end - 1] === "") end--;
    const content = body.slice(0, end);
    let out;
    if (style === "|") {
      out = content.join("\n");
    } else {
      out = "";
      let breaks = 0;
      let previousMore = false;
      content.forEach((l, n) => {
        if (l === "") return breaks++;
        const more = /^[ \t]/.test(l);
        if (n === breaks) out += "\n".repeat(breaks);
        else if (!more && !previousMore) out += breaks ? "\n".repeat(breaks) : " ";
        else out += "\n".repeat(breaks + 1);
        out += l;
        breaks = 0;
        previousMore = more;
      });
    }
    if (content.length && chomp !== "-") out += "\n";
    if (chomp === "+") out += "\n".repeat(body.length - end);
    return scalar(out, line);
  }

  // A flow collection or scalar starting at text[start], on one line: { value, end }.
  function flow(text, start, line) {
    let p = start;
    const space = () => {
      while (text[p] === " " || text[p] === "\t") p++;
    };
    function item() {
      space();
      const c = text[p];
      if (c === "[" || c === "{") {
        const open = c;
        const close = c === "[" ? "]" : "}";
        const out = open === "[" ? [] : new Map();
        const keys = new Set();
        p++;
        for (;;) {
          space();
          if (p >= text.length) throw new YamlError(line, "flow collections must fit on one line");
          if (text[p] === close) break;
          if (open === "[") {
            out.push(item());
          } else {
            const at = p;
            const key = item();
            if (typeof key !== "string") throw new YamlError(line, "flow keys must be scalars");
            if (keys.has(fold(key))) throw new YamlError(line, `duplicate key \`${key}\``);
            if (key === "<<" && text[at] !== '"' && text[at] !== "'") {
              throw new YamlError(line, "merge keys (`<<`) aren't supported");
            }
            keys.add(fold(key));
            space();
            if (text[p] !== ":") throw new YamlError(line, "flow mappings need `key: value`");
            p++;
            space();
            out.set(key, text[p] === "," || text[p] === "}" ? scalar("", line) : item());
          }
          space();
          if (text[p] === ",") p++;
          else if (text[p] !== close) {
            throw new YamlError(line, `expected \`,\` or \`${close}\` in a flow collection`);
          }
        }
        p++;
        return out;
      }
      if (c === '"' || c === "'") {
        const q = quoted(text, p, line);
        p = q.end;
        return scalar(q.value, line);
      }
      if (c === undefined || INDICATORS.has(c) || /^-([ \t]|$)/.test(text.slice(p, p + 2))) {
        throw new YamlError(
          line,
          `unsupported YAML in a flow collection: \`${c ?? "end of line"}\``,
        );
      }
      // Plain: up to a separator, a colon before one, or a comment.
      const from = p;
      while (p < text.length && !",[]{}".includes(text[p])) {
        if (text[p] === ":" && /^:([ \t,[\]{}]|$)/.test(text.slice(p, p + 2))) break;
        if (text[p] === "#" && /[ \t]/.test(text[p - 1])) {
          throw new YamlError(line, "flow collections must fit on one line");
        }
        p++;
      }
      return scalar(strip(text.slice(from, p)), line);
    }
    const value = item();
    return { value, end: p };
  }

  // One document: an optional `---` first, no directive.
  while (i < lines.length && /^[ \t]*(#.*)?$/.test(lines[i])) i++;
  if (/^%/.test(lines[i] ?? "")) throw new YamlError(i + 1, "YAML directives aren't supported");
  if (/^---([ \t]+#.*|[ \t]*)$/.test(lines[i] ?? "")) i++;
  const doc = node(-1);
  const rest = peek();
  if (rest) throw new YamlError(rest.line, "unexpected content");
  return doc;
}

// A mapping's value for `name`, its key matched without case (duplicates are refused).
function field(map, name) {
  for (const [key, value] of map) if (fold(key) === name) return value;
  return undefined;
}

const short = (value) => (value.length > 40 ? `${value.slice(0, 40)}…` : value);

// Why a `permissions:` value lets the token write, or does what a check can't read: read-all,
// {} and read or none scopes only.
function permissionProblems(value, where) {
  if (typeof value === "string") {
    return strip(value).toLowerCase() === "read-all"
      ? []
      : [`\`${where}: ${short(value)}\` is not allowed`];
  }
  if (!(value instanceof Map)) return [`\`${where}\` must be read-all or a mapping of scopes`];
  const problems = [];
  for (const [scope, level] of value) {
    if (typeof level !== "string" || !["read", "none"].includes(strip(level).toLowerCase())) {
      problems.push(`\`${where}.${scope}\` must be read or none`);
    }
  }
  return problems;
}

// Whether `value` spells `secrets`, also through letters that fold to it (`ſ`, full-width).
function spellsSecrets(value) {
  return [value, value.toUpperCase(), value.toLowerCase(), value.normalize("NFKC")].some((v) =>
    /secrets/i.test(v),
  );
}

// Why a workflow file a sandbox pushed can't run, as short sentences; none when it may. Its
// GITHUB_TOKEN reads at most (a top-level `permissions:` is required: without it, the
// repository's default applies, and that may write), and it names no secret: `secrets.X`,
// `secrets[...]`, `toJSON(secrets)`, `secrets: inherit` all spell it, in a key or a value.
export function workflowProblems(text) {
  const secrets = new Set();
  const expressions = new Set();
  let doc;
  try {
    doc = parseYaml(text, (value, line) => {
      if (spellsSecrets(value)) secrets.add(line);
      // GitHub reads an expression's names without case: no look-alike letter there.
      for (const [, inside] of value.matchAll(/\$\{\{([^]*?)(\}\}|$)/g)) {
        if (/[^\x00-\x7f]/.test(inside)) expressions.add(line);
      }
    });
  } catch (error) {
    if (error instanceof YamlError) return [`line ${error.line}: ${error.message}`];
    throw error;
  }
  if (!(doc instanceof Map)) return ["not a workflow (a mapping of keys)"];
  const problems = [];
  const top = field(doc, "permissions");
  if (top === undefined) {
    problems.push("no top-level `permissions:` (add `permissions: { contents: read }`)");
  } else {
    problems.push(...permissionProblems(top, "permissions"));
  }
  const jobs = field(doc, "jobs");
  if (jobs instanceof Map) {
    for (const [id, job] of jobs) {
      const own = job instanceof Map ? field(job, "permissions") : undefined;
      if (own !== undefined) problems.push(...permissionProblems(own, `jobs.${id}.permissions`));
    }
  }
  if (secrets.size) problems.push(`mentions \`secrets\` (line ${[...secrets].join(", ")})`);
  if (expressions.size) {
    problems.push(
      `non-ASCII characters in a \`\${{ }}\` expression (line ${[...expressions].join(", ")})`,
    );
  }
  return problems;
}
