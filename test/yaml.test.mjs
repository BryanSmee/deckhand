import assert from "node:assert/strict";
import { test } from "node:test";
import { YamlError, parseYaml } from "../listener/yaml.mjs";

test("mappings, lists, scalars and comments", () => {
  const doc = parseYaml(`---
# a comment
name: deckhand   # trailing comment
count: 3
ratio: 0.5
on: true
off: false
nothing: ~
empty:
quoted: "a: b # not a comment"
single: 'it''s'
url: https://example.com/#anchor
users: [alice, "Bob", 'c d']
none: []
flow: { a: 1, b: x }
nested:
  list:
  - one
  - two
  items:
    - path: /a
      read_only: true
    - path: /b
`);
  assert.deepEqual(doc, {
    name: "deckhand",
    count: 3,
    ratio: 0.5,
    on: true,
    off: false,
    nothing: null,
    empty: null,
    quoted: "a: b # not a comment",
    single: "it's",
    url: "https://example.com/#anchor",
    users: ["alice", "Bob", "c d"],
    none: [],
    flow: { a: 1, b: "x" },
    nested: {
      list: ["one", "two"],
      items: [{ path: "/a", read_only: true }, { path: "/b" }],
    },
  });
});

test("block scalars", () => {
  const doc = parseYaml(`literal: |
  npm ci
  echo "done" # kept

    indented
keep: |+
  a

strip: |-
  a
folded: >
  one
  two

  three
end: 1
`);
  assert.equal(doc.literal, 'npm ci\necho "done" # kept\n\n  indented\n');
  assert.equal(doc.keep, "a\n\n");
  assert.equal(doc.strip, "a");
  assert.equal(doc.folded, "one two\nthree\n");
  assert.equal(doc.end, 1);
});

test("an empty file is null", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# only a comment\n"), null);
});

test("what it doesn't understand is an error with its line", () => {
  for (const [text, message] of [
    ["a: 1\na: 2", /line 2: duplicate key "a"/],
    ["a:\n\t- x", /line 2: tabs/],
    ["base: &b 1", /anchors/],
    ["a: *b", /anchors/],
    ["a: !!str 1", /tags/],
    ["a: 1\n---\nb: 2", /line 2: only one document/],
    ["a: b: c", /quote values/],
    ['a: "open', /unclosed quote/],
    ["a: [1, [2]]", /nested/],
    ["a: [1,\n  2]", /one line/],
    ["a: 1\n  b: 2", /line 2: unexpected indentation/],
    ["- a\nb: 1", /line 2/],
    ["just text", /expected "key: value"/],
  ]) {
    assert.throws(
      () => parseYaml(text),
      (error) => error instanceof YamlError && message.test(error.message),
      text,
    );
  }
});
