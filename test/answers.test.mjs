import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TEXT, answersComment, parseAnswers } from "../listener/answers.mjs";
import { MARKER } from "../listener/events.mjs";

const parse = parseAnswers;

test("parseAnswers: one answer per question, or one text", () => {
  assert.deepEqual(parse({ number: 3, answers: [{ options: [2, 2], text: " a " }, {}] }), {
    number: 3,
    pr: false,
    answers: [
      { options: [2], text: "a" },
      { options: [], text: "" },
    ],
    text: null,
    then: null,
  });
  assert.deepEqual(parse({ number: 3, pr: true, text: " yes " }), {
    number: 3,
    pr: true,
    answers: null,
    text: "yes",
    then: null,
  });
});

test("parseAnswers: the App's marks are taken out of the text, and the notes", () => {
  const tag = "<!-- deckhand-from:bob:abc -->";
  assert.equal(parse({ number: 3, text: `yes ${MARKER}${tag}` }).text, "yes");
  assert.equal(parse({ number: 3, answers: [{ text: `a${MARKER}` }] }).answers[0].text, "a");
  assert.equal(parse({ number: 3, text: `ok <!-- deck${MARKER}hand -->` }).text, "ok");
  // Nothing left: empty.
  assert.throws(() => parse({ number: 3, text: MARKER }), /empty/);
});

test("parseAnswers: refuses what isn't an answer", () => {
  for (const bad of [
    null,
    JSON.stringify({ number: "3", text: "x" }),
    JSON.stringify({ number: 3 }),
    JSON.stringify({ number: 3, text: "x", answers: [] }),
    JSON.stringify({ number: 3, pr: "yes", text: "x" }),
    JSON.stringify({ number: 3, text: 4 }),
    JSON.stringify({ number: 3, text: "" }),
    JSON.stringify({ number: 3, answers: {} }),
    JSON.stringify({ number: 3, answers: [{ options: [-1] }] }),
    JSON.stringify({ number: 3, answers: [{ options: [0, 1] }] }),
    JSON.stringify({ number: 3, answers: [{ options: ["0"] }] }),
    JSON.stringify({ number: 3, answers: [{ text: 1 }] }),
    JSON.stringify({ number: 3, answers: [{}, { options: [] }] }),
    JSON.stringify({ number: 3, text: "x".repeat(MAX_TEXT + 1) }),
  ]) {
    assert.throws(() => parseAnswers(JSON.parse(bad)), { status: 400 }, bad);
  }
  const long = { text: "x".repeat(MAX_TEXT / 2 + 1) };
  assert.throws(() => parse({ number: 3, answers: [long, long] }), { status: 413 });
});

test("answersComment: a note keeps its lines under its question", () => {
  const items = [{ title: "Name", text: "What name?", options: [] }];
  const { comment, open } = answersComment(
    "bob",
    items,
    parse({ number: 1, answers: [{ text: "Two lines:\n\n- a list" }] }),
  );
  assert.equal(
    comment,
    "Answers from @bob, from the dashboard:\n\n1. **Name**\n   - Two lines:\n     \n     - a list",
  );
  assert.deepEqual(open, []);
});
