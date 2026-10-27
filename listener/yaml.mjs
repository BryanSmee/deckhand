// A small YAML reader for per-repo config files (.deckhand.yaml): no dependencies, so only
// the part of YAML a config needs. Block mappings and sequences, flow sequences and mappings
// on one line, quoted and plain scalars, literal (|) and folded (>) blocks, comments.
// Anchors, aliases, tags and multiple documents are refused rather than half understood.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
  }
}

// A mapping, as parseYaml() returns them: not null, not a list.
export function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// `where`: a Map to fill with the line of each key and list item, by its dotted path
// ("modes.review.agent", "mounts.0"), so a config's errors can point at their line.
export function parseYaml(text, where = null) {
  const lines = String(text)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, n: i + 1 }));
  // The reader's position, shared by the steps below: they consume lines as they go.
  const doc = { lines, i: 0, started: false, where };
  const result = block(doc, 0, "");
  const left = peek(doc);
  if (left) throw new YamlError("unexpected indentation", left.n);
  return result;
}

// The next line that holds something, as { indent, text, n }; null at the end.
function peek(doc) {
  const { lines } = doc;
  while (doc.i < lines.length) {
    const { raw, n } = lines[doc.i];
    if (lines[doc.i].indent !== undefined) return lines[doc.i]; // reshaped by a sequence item
    const body = raw.trimStart();
    const indentation = raw.slice(0, raw.length - body.length);
    if (!body || body.startsWith("#")) {
      doc.i++;
      continue;
    }
    if (indentation.includes("\t")) throw new YamlError("tabs can't indent YAML", n);
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) {
      if (raw.startsWith("---") && !doc.started && !stripComment(raw.slice(3), n).trim()) {
        doc.started = true;
        doc.i++;
        continue;
      }
      if (raw.startsWith("...")) {
        doc.i = lines.length;
        return null;
      }
      throw new YamlError("only one document per file", n);
    }
    doc.started = true;
    lines[doc.i] = { raw, n, indent: indentation.length, text: body };
    return lines[doc.i];
  }
  return null;
}

const isItem = (line) => line.text === "-" || line.text.startsWith("- ");

// `path`'s child `key`, noted at line `n` when the caller asked where keys are.
function child(doc, path, key, n) {
  const at = path ? `${path}.${key}` : String(key);
  if (doc.where && !doc.where.has(at)) doc.where.set(at, n);
  return at;
}

function block(doc, indent, path) {
  const line = peek(doc);
  if (!line || line.indent < indent) return null;
  return isItem(line) ? sequence(doc, line.indent, path) : mapping(doc, line.indent, path);
}

function mapping(doc, indent, path) {
  const result = {};
  for (let line = peek(doc); line && line.indent >= indent; line = peek(doc)) {
    if (line.indent > indent) throw new YamlError("unexpected indentation", line.n);
    if (isItem(line)) throw new YamlError("a list item where a key was expected", line.n);
    const { key, rest } = splitKey(line.text, line.n);
    if (Object.hasOwn(result, key)) throw new YamlError(`duplicate key "${key}"`, line.n);
    doc.i++;
    result[key] = value(doc, rest, indent, line.n, true, child(doc, path, key, line.n));
  }
  return result;
}

function sequence(doc, indent, path) {
  const result = [];
  for (let line = peek(doc); line && line.indent === indent && isItem(line); line = peek(doc)) {
    const rest = line.text.slice(1).trimStart();
    const item = child(doc, path, result.length, line.n);
    if (rest && !rest.startsWith("#") && keyAt(rest) >= 0) {
      // "- name: x" starts a mapping whose keys line up with "name".
      line.indent += line.text.length - rest.length;
      line.text = rest;
      result.push(mapping(doc, line.indent, item));
      continue;
    }
    doc.i++;
    result.push(value(doc, rest, indent, line.n, false, item));
  }
  const line = peek(doc);
  if (line && line.indent > indent) throw new YamlError("unexpected indentation", line.n);
  return result;
}

// What follows "key:" or "- ": a scalar, a flow collection, a block scalar, or a nested block.
function value(doc, rest, indent, n, inMapping, path) {
  const text = stripComment(rest, n).trim();
  if (!text) {
    const next = peek(doc);
    // A mapping's list may sit at the key's own indentation.
    if (next && (next.indent > indent || (inMapping && next.indent === indent && isItem(next)))) {
      return block(doc, next.indent, path);
    }
    return null;
  }
  if (/^[|>]/.test(text)) return blockScalar(doc, text, indent, n);
  if (text.startsWith("[") || text.startsWith("{")) return flow(doc, text, n, path);
  return scalar(text, n);
}

function blockScalar(doc, header, indent, n) {
  const match = /^([|>])([+-]?)$/.exec(header);
  if (!match) throw new YamlError(`unsupported block header "${header}"`, n);
  const [, style, chomp] = match;
  const body = blockLines(doc, indent);
  let end = body.length;
  while (end > 0 && body[end - 1] === "") end--;
  const content = body.slice(0, end);
  const trailing = body.length - end;
  let out = style === "|" ? content.join("\n") : fold(content);
  if (!content.length) return "";
  if (chomp === "") out += "\n";
  if (chomp === "+") out += "\n".repeat(trailing + 1);
  return out;
}

// A block scalar's lines, without their indentation: up to the first line indented less.
function blockLines(doc, indent) {
  const { lines } = doc;
  const body = [];
  let own = null; // the block's indentation, from its first non-blank line
  while (doc.i < lines.length) {
    const raw = lines[doc.i].raw;
    if (raw.trim()) {
      const width = raw.length - raw.trimStart().length;
      if (own === null) {
        if (width <= indent) break;
        own = width;
      }
      if (width < own) break;
      body.push(raw.slice(own));
    } else {
      body.push("");
    }
    doc.i++;
  }
  return body;
}

// Folded (>) block: lines join with spaces, a blank line is a line break.
function fold(content) {
  let out = "";
  content.forEach((line, k) => {
    if (k === 0) out = line;
    else if (line === "") out += "\n";
    else out += content[k - 1] === "" ? line : ` ${line}`;
  });
  return out;
}

// Where "key:" ends in a line ("key: value" or "key:"), or -1. Quoted keys allowed.
function keyAt(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const close = closingQuote(text, 0);
    if (close < 0) return -1;
    return /^:(\s|$)/.test(text.slice(close + 1)) ? close + 1 : -1;
  }
  if (/^[[{]/.test(text)) return -1;
  const match = /:(\s|$)/.exec(text);
  if (!match) return -1;
  // "a #b: c" is a comment, not a key.
  const hash = /(^|\s)#/.exec(text);
  return hash && hash.index < match.index ? -1 : match.index;
}

function splitKey(text, n) {
  const at = keyAt(text);
  if (at < 0) throw new YamlError(`expected "key: value", got "${text}"`, n);
  const rawKey = text.slice(0, at).trim();
  const key = /^["']/.test(rawKey) ? scalar(rawKey, n) : rawKey;
  if (!key && key !== 0) throw new YamlError("empty key", n);
  return { key: String(key), rest: text.slice(at + 1) };
}

function closingQuote(text, start) {
  const quote = text[start];
  for (let k = start + 1; k < text.length; k++) {
    if (quote === '"' && text[k] === "\\") k++;
    else if (text[k] === quote) {
      if (quote === "'" && text[k + 1] === "'") k++;
      else return k;
    }
  }
  return -1;
}

// Drops a trailing "# comment", outside quotes.
function stripComment(text, n) {
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if ((c === '"' || c === "'") && (k === 0 || /[\s[{,:]/.test(text[k - 1]))) {
      const close = closingQuote(text, k);
      if (close < 0) throw new YamlError("unclosed quote", n);
      k = close;
    } else if (c === "#" && (k === 0 || /\s/.test(text[k - 1]))) {
      return text.slice(0, k);
    }
  }
  return text;
}

function scalar(text, n) {
  if (text.startsWith('"')) {
    if (closingQuote(text, 0) !== text.length - 1) throw new YamlError("text after a quote", n);
    try {
      // Same escapes as JSON for what a config needs (\n, \t, \", \\, \u…).
      return JSON.parse(text.replace(/\t/g, "\\t"));
    } catch {
      throw new YamlError(`bad escape in ${text}`, n);
    }
  }
  if (text.startsWith("'")) {
    if (closingQuote(text, 0) !== text.length - 1) throw new YamlError("text after a quote", n);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!%@`]/.test(text)) {
    throw new YamlError(`anchors, aliases, tags and directives are not supported: ${text}`, n);
  }
  if (/:(\s|$)/.test(text)) throw new YamlError(`quote values that contain ": " (${text})`, n);
  if (/^(null|Null|NULL|~)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

// "[a, 'b, c']" or "{ key: value }" on one line; no nesting.
function flow(doc, text, n, path) {
  const open = text[0];
  const close = open === "[" ? "]" : "}";
  if (!text.endsWith(close)) throw new YamlError(`flow ${open}…${close} must fit on one line`, n);
  const parts = [];
  let current = "";
  const inner = text.slice(1, -1);
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === '"' || c === "'") {
      const end = closingQuote(inner, k);
      if (end < 0) throw new YamlError("unclosed quote", n);
      current += inner.slice(k, end + 1);
      k = end;
    } else if (c === "[" || c === "{") {
      throw new YamlError("nested flow collections are not supported", n);
    } else if (c === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current.trim());
  // "[]", or a trailing comma: "[a, b,]".
  if (parts.at(-1) === "") parts.pop();
  if (parts.some((p) => !p)) throw new YamlError("empty item in a flow collection", n);
  if (open === "[") {
    parts.forEach((p, k) => child(doc, path, k, n));
    return parts.map((p) => scalar(p, n));
  }
  const result = {};
  for (const part of parts) {
    const { key, rest } = splitKey(part, n);
    if (Object.hasOwn(result, key)) throw new YamlError(`duplicate key "${key}"`, n);
    child(doc, path, key, n);
    result[key] = rest.trim() ? scalar(rest.trim(), n) : null;
  }
  return result;
}
