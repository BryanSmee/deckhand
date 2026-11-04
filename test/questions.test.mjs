import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createInputs } from "../listener/inputs.mjs";
import {
  allTicked,
  applyInput,
  hasOpenQuestions,
  inputEvent,
  parseQuestions,
  questionsSection,
  replyQuestions,
  stillAsks,
  withoutMarker,
} from "../listener/questions.mjs";
import { outcome } from "../listener/runlog.mjs";
import { Refused } from "../lib/http.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

// Real issue bodies: #77, #79, #130 and #134 (filed by an inbox run, questions pending), #67
// ("None").
const body = (n) => readFileSync(new URL(`fixtures/issue-${n}.md`, import.meta.url), "utf8");
const config = testConfig({ ALLOWED_USERS: "alice,bob", ALLOWED_REPOS: "org/repo" });
const BOT = "deckhand-x[bot]";

test("open questions in real issues: #77 and #79 ask, #67 says None", () => {
  assert.equal(hasOpenQuestions(body(77)), true);
  assert.equal(hasOpenQuestions(body(79)), true);
  assert.equal(hasOpenQuestions(body(67)), false);
  assert.match(questionsSection(body(79)), /^1\. \*\*Command name\*\*/);
});

test("open questions: None, its variants and the inbox link after it", () => {
  const inbox = "\n\nFrom the ideas inbox: https://github.com/org/repo/issues/15#issuecomment-1\n";
  assert.equal(hasOpenQuestions(`## Open questions\n\nNone.${inbox}`), false);
  for (const none of ["None", "- None", "_None._", "**None**", "N/A", "No open questions."]) {
    assert.equal(hasOpenQuestions(`## Open questions\n\n${none}\n`), false, none);
  }
  assert.equal(hasOpenQuestions(`## Open questions\n\n1. Which name?${inbox}`), true);
  // A brainstorm's wrap-up: settled questions under Decisions, "None" left in Open questions.
  const wrapped =
    "## Proposal\n\nX.\n\n## Decisions\n\n1. **Name**: which one?\n   - [x] `deck`\n\n" +
    "## Open questions\n\nNone\n\nFrom the brainstorm on #150.\n";
  assert.equal(hasOpenQuestions(wrapped), false);
  assert.equal(parseQuestions(questionsSection(wrapped)), null);
  // Any heading level, a colon, a hand-written intro before the list.
  assert.equal(hasOpenQuestions("### Open Questions:\n\nTwo things:\n\n- A?\n- B?"), true);
  // Empty, only a comment, or no such section.
  assert.equal(hasOpenQuestions("## Open questions\n\n## Next\n\nText"), false);
  assert.equal(hasOpenQuestions("## Open questions\n<!-- none yet -->\n"), false);
  assert.equal(hasOpenQuestions("## Problem\n\nIt breaks.\n"), false);
  assert.equal(hasOpenQuestions(null), false);
  // A heading in a code block isn't one; a deeper heading stays in the section.
  assert.equal(hasOpenQuestions("```\n## Open questions\n1. x\n```\n"), false);
  assert.equal(
    questionsSection("## Open questions\n\n### A\n\n1. x\n\n## B\n\ny"),
    "### A\n\n1. x",
  );
});

const free = (text, title = null) => ({ title, text, options: [] });

test("parsed questions: titles, options, the recommended one, explanation lines", () => {
  const section = [
    "1. **Phones**: chains left to right with sideways scrolling, or top to bottom on phones only?",
    "   - [ ] Left to right, scrolling sideways (recommended)",
    "   - [ ] Top to bottom on phones only",
    "2. **Link text**: what should the header link say?",
    "3. Which colour?",
    "   The header is dark in both themes.",
    "",
    "   Today it is grey.",
    "   * [x] Blue",
    "   * [ ] Green (Recommended)",
    "4. **Order:** newest first?",
  ].join("\n");
  assert.deepEqual(parseQuestions(section), {
    items: [
      {
        title: "Phones",
        text: "chains left to right with sideways scrolling, or top to bottom on phones only?",
        options: [
          { label: "Left to right, scrolling sideways", recommended: true, checked: false },
          { label: "Top to bottom on phones only", recommended: false, checked: false },
        ],
      },
      free("what should the header link say?", "Link text"),
      {
        title: null,
        text: "Which colour?\nThe header is dark in both themes.\nToday it is grey.",
        options: [
          { label: "Blue", recommended: false, checked: true },
          { label: "Green", recommended: true, checked: false },
        ],
      },
      free("newest first?", "Order"),
    ],
    raw: section,
  });
});

test("parsed questions: a bullet explanation line before the options", () => {
  const section = [
    "1. **Event availability**: what can `events_available` open?",
    "   - The original tool keeps an available/locked/completed state per event.",
    "   - [ ] Events locked by `events_locked` (recommended)",
    "   - [ ] Those, and events marked `initially_locked: true`",
    "2. Which colour?",
    "   * The header is dark.",
    "   Today it is grey.",
    "",
    "   - [x] Blue",
  ].join("\n");
  assert.deepEqual(parseQuestions(section).items, [
    {
      title: "Event availability",
      text:
        "what can `events_available` open?\n" +
        "The original tool keeps an available/locked/completed state per event.",
      options: [
        { label: "Events locked by `events_locked`", recommended: true, checked: false },
        {
          label: "Those, and events marked `initially_locked: true`",
          recommended: false,
          checked: false,
        },
      ],
    },
    {
      title: null,
      text: "Which colour?\nThe header is dark.\nToday it is grey.",
      options: [{ label: "Blue", recommended: false, checked: true }],
    },
  ]);
  // A link starting the line is an explanation, not a box.
  const link = "1. A?\n   - [ab](https://x) explains it.\n   - [ ] B";
  assert.equal(parseQuestions(link).items[0].text, "A?\n[ab](https://x) explains it.");
});

test("parsed questions: None, an intro and the inbox link around the list", () => {
  assert.equal(parseQuestions("None."), null);
  assert.equal(parseQuestions(""), null);
  assert.equal(parseQuestions(null), null);
  const raw = "Two things:\n\n1. A?\n2) B?\n\nFrom the ideas inbox: https://x/1#issuecomment-2";
  assert.deepEqual(parseQuestions(raw), { items: [free("A?"), free("B?")], raw });
  // A line wrapped without indenting it is still the question's.
  assert.deepEqual(parseQuestions("1. A long\nquestion?").items, [free("A long\nquestion?")]);
});

test("parsed questions in another format: only the markdown", () => {
  for (const raw of [
    // Prose, or a bullet list.
    "Which colour should it be?",
    "- Blue?\n- Green?",
    // Options without checkboxes, nested numbers, text after the options.
    "1. Colour?\n   - Blue\n   - Green",
    "1. Colour?\n   1. Blue\n   2. Green",
    "1. Colour?\n   - [ ] Blue\n   Or something else.",
    // Bullets that no options follow, in the question or before the next one.
    "1. Colour?\n   - Blue\n2. B?\n   - [ ] X",
    "1. Colour?\n   - Blue\n\nFrom the ideas inbox: https://x/1",
    // A paragraph between two questions, two picks, an empty question or option.
    "1. A?\n\nSome context.\n\n2. B?",
    "1. A?\n   - [ ] X (recommended)\n   - [ ] Y (recommended)",
    "1. **:**\n2. B?",
    "1. ** **:\n2. B?",
    "1. A?\n   - [ ] (recommended)",
    // A first option empty or mistyped is not an explanation line.
    "1. A?\n   - [ ]\n   - [ ] B",
    "1. A?\n   - [x]\n   - [ ] B",
    "1. A?\n   - [ ]Blue\n   - [ ] B",
    "1. A?\n   - [y] Blue\n   - [ ] B",
    "1. A?\n   - [x ]\n   - [ ] B",
    "1. A?\n   - [ x] Blue\n   - [ ] B",
    "1. A?\n   - [ x ] Blue\n   - [  ] B",
    // Extra spaces before the box, or an empty bullet.
    "1. A?\n   -  [x]\n   - [ ] B",
    "1. A?\n   -  [ ]Blue\n   - [ ] B",
    "1. A?\n   -  [x ] Blue\n   - [ ] B",
    "1. A?\n   - \n   - [ ] B",
  ]) {
    assert.deepEqual(parseQuestions(raw), { items: null, raw }, raw);
  }
});

// #609's section: a question that is all title, its pick with a reason.
const ALL_TITLE = [
  "1. **Who serves `GET /shots/`**:",
  "   - [ ] Edge passes it on to the broker (recommended: the orchestrator stays out of it)",
  "   - [ ] Edge passes it on to the orchestrator, which asks the broker (no new route on edge, one more hop)",
  "",
  "Part of #604.",
].join("\n");

test("parsed questions: a question all title, a pick with its reason", () => {
  assert.deepEqual(parseQuestions(ALL_TITLE).items, [
    {
      title: null,
      text: "Who serves `GET /shots/`",
      options: [
        {
          label: "Edge passes it on to the broker (the orchestrator stays out of it)",
          recommended: true,
          checked: false,
        },
        {
          label:
            "Edge passes it on to the orchestrator, which asks the broker (no new route on edge, one more hop)",
          recommended: false,
          checked: false,
        },
      ],
    },
  ]);
  assert.deepEqual(parseQuestions("1. **Colour?:**\n2. **B**: which?").items, [
    free("Colour?"),
    { title: "B", text: "which?", options: [] },
  ]);
  const label = (option) =>
    parseQuestions(`1. A?\n   - [ ] ${option}\n   - [ ] Y`).items[0].options[0];
  assert.deepEqual(label("X (recommended, simpler)"), {
    label: "X (simpler)",
    recommended: true,
    checked: false,
  });
  assert.deepEqual(label("X (Recommended - simpler)").label, "X (simpler)");
  assert.deepEqual(label("X (recommended:)"), { label: "X", recommended: true, checked: false });
  // Not a pick: the word elsewhere, or not first in the parentheses.
  assert.deepEqual(label("X (not recommended)"), {
    label: "X (not recommended)",
    recommended: false,
    checked: false,
  });
  assert.equal(label("X (recommended) for now").recommended, false);
  // One pick still, whichever way it is written; an option that is only its pick is none.
  for (const raw of [
    "1. A?\n   - [ ] X (recommended: simpler)\n   - [ ] Y (recommended)",
    "1. A?\n   - [ ] (recommended: simpler)\n   - [ ] Y",
  ]) {
    assert.deepEqual(parseQuestions(raw), { items: null, raw }, raw);
  }
  // A ticked box answers it.
  assert.equal(allTicked(parseQuestions(ALL_TITLE)), false);
  const ticked = ALL_TITLE.replace(
    "- [ ] Edge passes it on to the orchestrator",
    "- [x] Edge passes it on to the orchestrator",
  );
  assert.equal(allTicked(parseQuestions(ticked)), true);
  assert.equal(stillAsks(`Body.\n\n## Open questions\n\n${ALL_TITLE}`), true);
  assert.equal(stillAsks(`Body.\n\n## Open questions\n\n${ticked}`), false);
});

test("parsed questions of real issues, as filed before the format", () => {
  assert.deepEqual(parseQuestions(questionsSection(body(130))).items.length, 3);
  assert.deepEqual(parseQuestions(questionsSection(body(134))).items, [
    free(
      'Should the nav link say **Home** or **Tasks**? "Tasks" says what the page shows. ' +
        "I'd go with **Home**, since that's the word in the request.",
    ),
  ]);
  const titled = parseQuestions(questionsSection(body(79))).items;
  assert.deepEqual(
    titled.map((q) => q.title),
    ["Command name", "When a blocker counts as done", "Cancelling", "GitHub's native dependencies"],
  );
  assert.equal(parseQuestions(questionsSection(body(67))), null);
  assert.equal(parseQuestions(questionsSection(body(130))).items[0].title, null);
});

test("a run's questions: after its needs-input heading, up to the next heading", () => {
  const reply = [
    "<!-- needs-input -->",
    "## Needs your input",
    "",
    "1. **Schema**: drop the old column?",
    "   - [ ] Yes, migrate the rows first (recommended)",
    "   - [ ] No, keep both",
    "",
    "### What I checked",
    "",
    "1. The migrations.",
  ].join("\n");
  assert.deepEqual(replyQuestions(reply), {
    items: [
      {
        title: "Schema",
        text: "drop the old column?",
        options: [
          { label: "Yes, migrate the rows first", recommended: true, checked: false },
          { label: "No, keep both", recommended: false, checked: false },
        ],
      },
    ],
    raw: reply.split("\n").slice(3, 6).join("\n"),
  });
  // No heading: up to the first one; no marker or nothing asked: none.
  assert.deepEqual(replyQuestions("<!-- needs-input -->\n1. A?\n## Rest\n2. B?").items, [
    free("A?"),
  ]);
  assert.equal(replyQuestions("Done.\n\n1. A?"), null);
  assert.equal(replyQuestions("<!-- needs-input -->\n## Needs your input\n\nNone."), null);
  // Under an "Open questions" heading of their own: that section.
  const titled = reply.replace(
    "## Needs your input\n",
    "## Needs your input\n\n### Open questions\n",
  );
  assert.deepEqual(replyQuestions(titled), replyQuestions(reply));
  assert.equal(
    replyQuestions(
      "<!-- needs-input -->\n## Needs your input\n### Open questions\nNone\n## Checked",
    ),
    null,
  );
  assert.equal(replyQuestions(null), null);
});

test("a run's questions in another language: translated headings, title and pick", () => {
  // Issue #705: a run writing in French translated what the prompt asks it to keep.
  const reply = [
    "<!-- needs-input -->",
    "## Besoin de votre avis",
    "",
    "### Questions ouvertes",
    "",
    "1. **Schéma** : supprimer l'ancienne colonne ?",
    "   - [ ] Oui, migrer les lignes d'abord (recommandé : plus sûr)",
    "   - [ ] Non, garder les deux",
    "",
    "### Ce que j'ai vérifié",
    "",
    "Les migrations.",
  ].join("\n");
  const items = [
    {
      title: "Schéma",
      text: "supprimer l'ancienne colonne ?",
      options: [
        { label: "Oui, migrer les lignes d'abord (plus sûr)", recommended: true, checked: false },
        { label: "Non, garder les deux", recommended: false, checked: false },
      ],
    },
  ];
  assert.deepEqual(replyQuestions(reply).items, items);
  // Headings the listener doesn't know: the first part whose questions have options, after an
  // intro under the reply's own heading.
  const other = reply
    .replace("### Questions ouvertes", "Il me faut votre avis.\n\n### Questions")
    .replace("Les migrations.", "1. Les migrations.");
  assert.deepEqual(replyQuestions(other).items, items);
  // An intro starting with a translated "None" word is no "None".
  const intro = reply.replace(
    "### Questions ouvertes",
    "Aucune des deux options ne convient sans votre choix.\n\n### Questions",
  );
  assert.deepEqual(replyQuestions(intro).items, items);
  // Only the marker on a line of its own: one quoted in a sentence before it isn't the start.
  const quoted = `Je réponds avec \`<!-- needs-input -->\` en tête.\n${reply}`;
  assert.deepEqual(replyQuestions(quoted), replyQuestions(reply));
  // Under translated headings after an intro, free-text questions alone are the questions too.
  assert.deepEqual(
    replyQuestions(
      "<!-- needs-input -->\n## Besoin de votre avis\n\nUne question.\n\n## Questions\n\n1. **Nom** : quel nom ?",
    ).items,
    [free("quel nom ?", "Nom")],
  );
  // Questions without options right under the first heading are still the questions.
  assert.deepEqual(
    replyQuestions("<!-- needs-input -->\n## Avis\n1. A ?\n## Vérifié\n2. B ?").items,
    [free("A ?")],
  );
  // "None" translated: nothing asked, unless questions follow it.
  assert.equal(
    replyQuestions("<!-- needs-input -->\n## Avis\n\nAucune.\n\n## Vérifié\n\nRien."),
    null,
  );
  const sorry = "<!-- needs-input -->\n## Avis\n\nAucune question simple ici, désolé.";
  assert.deepEqual(replyQuestions(`${sorry}\n\n## Suite\n1. A ?\n   - [ ] Oui`).items, [
    { title: null, text: "A ?", options: [{ label: "Oui", recommended: false, checked: false }] },
  ]);
  // An English pick with a space before the title's colon, and inside the bold.
  assert.deepEqual(parseQuestions("1. **Name :** which one?\n   - [ ] A (Recommended)").items[0], {
    title: "Name",
    text: "which one?",
    options: [{ label: "A", recommended: true, checked: false }],
  });
});

test("a body of None lines: read in one pass, as any other", () => {
  // Anyone's edit is read (editedInput()): one recursion per line overflowed the stack.
  const body = `## Open questions\n\n${"None\n".repeat(20000)}`;
  assert.equal(hasOpenQuestions(body), false);
  assert.equal(parseQuestions(questionsSection(body)), null);
  assert.equal(hasOpenQuestions(`## Open questions\n\n${"None\n\n".repeat(20000)}`), false);
});

test("long lines: an unclosed title, a pick or a heading read in one pass", () => {
  // Anyone's edit is read (editedInput()): a regex that tries every length of a run of spaces
  // blocked the orchestrator for seconds.
  const spaces = " ".repeat(65000);
  const title = parseQuestions(`1. **${spaces}x\n   - [ ] A`).items[0];
  assert.deepEqual([title.title, title.text], [null, `**${spaces}x`]);
  const pick = parseQuestions(`1. Q?\n   - [ ] A (recommended: ${spaces}x\n   - [ ] B`);
  assert.deepEqual(pick.items[0].options[0], {
    label: `A (recommended: ${spaces}x`,
    recommended: false,
    checked: false,
  });
  const option = parseQuestions(`1. Q?\n   - [ ] A${spaces}x`).items[0].options[0];
  assert.equal(option.label, `A${spaces}x`);
  assert.equal(hasOpenQuestions(`# a${spaces}x\n\n1. A?`), false);
  assert.equal(questionsSection(`## Open questions${spaces}##\n\n1. A?`), "1. A?");
  // A pick never closed (issue #736).
  const open = parseQuestions(`1. Q?\n   - [ ] A (recommended${spaces}\n   - [ ] B`);
  assert.equal(open.items[0].options[0].label, "A (recommended");
  assert.equal(open.items[0].options[0].recommended, false);
});

test("HTML comments: dropped, an unclosed one kept, read in one pass", () => {
  const read = parseQuestions("1. Q? <!-- note -->\n   - [ ] A <!-- a\nb --> (recommended)");
  assert.deepEqual(read.items[0], {
    title: null,
    text: "Q?",
    options: [{ label: "A", recommended: true, checked: false }],
  });
  assert.equal(parseQuestions("<!-- only a comment -->"), null);
  assert.equal(parseQuestions("1. Q? <!-- never closed").items[0].text, "Q? <!-- never closed");
  // Anyone's edit is read (editedInput()): a lazy regex looked for `-->` from each `<!--`.
  const many = "<!--".repeat(16000);
  assert.ok(parseQuestions(`1. Q?\n${many}`).items[0].text === `Q?\n${many}`);
  assert.equal(hasOpenQuestions(`## Open questions\n\n${many}`), true);
});

test("withoutMarker: the marker asksInput() reads, not one quoted or shown in code", () => {
  assert.equal(withoutMarker("<!-- needs-input -->\nWhich?"), "\nWhich?");
  assert.equal(withoutMarker("## Avis\n<!-- needs-input -->\n1. A ?"), "## Avis\n\n1. A ?");
  const shown = "Done.\n```\n<!-- needs-input -->\n```";
  assert.equal(withoutMarker(shown), shown);
  const quoted = "Starts with `<!-- needs-input -->`.\n<!-- needs-input -->\nWhich?";
  assert.equal(withoutMarker(quoted), "Starts with `<!-- needs-input -->`.\n\nWhich?");
});

test("a pick in other languages: each form of recommended", () => {
  for (const pick of [
    "recommended",
    "recommandé",
    "recommandée",
    "recomendado",
    "recomendada",
    "empfohlen",
    "raccomandato",
    "raccomandata",
    "consigliato",
    "consigliata",
  ]) {
    const [a, b] = parseQuestions(`1. Which?\n   - [ ] A (${pick}: why)\n   - [ ] B`).items[0]
      .options;
    assert.deepEqual([a.label, a.recommended, b.recommended], ["A (why)", true, false], pick);
  }
  const decomposed = parseQuestions("1. Which?\n   - [ ] A (recommande\u0301)").items[0].options[0];
  assert.equal(decomposed.recommended, true);
});

test("issue bodies: open questions and None in English and a few other languages", () => {
  const asked = (heading) => `## Problem\n\nX.\n\n## ${heading}\n\n1. **Titre** : lequel ?\n`;
  for (const heading of [
    "Open questions",
    "Questions ouvertes",
    "Preguntas abiertas",
    "Offene Fragen",
    "Perguntas em aberto",
    "Domande aperte",
    "Questions ouvertes :",
    "Questions en suspens",
    "Preguntas pendientes",
    "Perguntas abertas",
    "Questões em aberto",
    "Questo\u0303es em aberto",
  ]) {
    assert.equal(hasOpenQuestions(asked(heading)), true, heading);
    assert.equal(parseQuestions(questionsSection(asked(heading))).items[0].title, "Titre");
  }
  assert.equal(hasOpenQuestions(asked("Questions")), false);
  const none = (heading, text) => `## ${heading}\n\n${text}\n\nFrom the inbox: x`;
  for (const [heading, text] of [
    ["Open questions", "None."],
    ["Open questions", "Aucune."],
    ["Questions ouvertes", "Aucune"],
    ["Preguntas abiertas", "Ninguna."],
    ["Offene Fragen", "Keine."],
    ["Perguntas abertas", "Nenhuma."],
    ["Domande aperte", "Nessuna."],
    ["Questions ouvertes", "Néant."],
  ]) {
    assert.equal(hasOpenQuestions(none(heading, text)), false, `${heading}: ${text}`);
  }
  // "None" then more on its line, or the inbox link right under it: nothing asked, as before.
  for (const text of [
    "None\nFrom the inbox: https://github.com/org/repo/issues/1#issuecomment-2",
    "None for now.",
    "None yet",
    "None at this time.",
    // What was settled, its boxes ticked: answers, not questions.
    "None. Settled:\n\n1. **X**: which?\n   - [x] A\n   - [ ] B",
    "Rien.",
    "Nada.",
    "Não há.",
    "Kein.",
    "Rien !",
    "Aucune question.",
    "Keine offenen Fragen",
    "Nessuna domanda",
    "Ninguna pregunta.",
    "Nenhuma questão",
    // A list after it that asks nothing: notes under a heading, what was settled, code.
    "None\n\n### Notes\n\n1. something done",
    "None. Settled on the issue:\n\n1. Use X (decided)",
    "None\n\n```\n1. code\n   - [ ] x\n```",
    // Written decomposed (e and its accent), as some editors do.
    "ne\u0301ant",
  ]) {
    assert.equal(hasOpenQuestions(none("Open questions", text)), false, text);
  }
  // A sentence that starts with a translated word asks, whatever follows it: only the word
  // alone, or the "no questions" phrase alone, is "None".
  for (const text of [
    "Keine der beiden Varianten passt: welche?\n\n1. A?\n   - [ ] Oui",
    "Aucune des deux options ne convient : laquelle ?\n\n1. A?\n   - [ ] Oui",
    "Aucune question n'est tranchée : laquelle ?",
    "Nessuna delle due va bene: quale?",
    "Nessun dubbio.",
    // Hand-written, not in the format.
    "Keine Ahnung, welche Variante?\n\n- Variante A\n- Variante B",
    "Kein Test deckt X ab. Soll ich einen schreiben?",
    // Free-text questions, the first one starting with the word.
    "1. **Keine Migration**: soll ich eine schreiben?",
    "1. Rien ne couvre X : faut-il un test ?",
    "1. **Keine Migration**: soll ich eine schreiben?\n2. **Name**: welcher?",
  ]) {
    assert.equal(hasOpenQuestions(none("Open questions", text)), true, text);
  }
  // English as on main: the word starting the first paragraph is "None", whatever follows.
  assert.equal(hasOpenQuestions(none("Open questions", "None of these: which?\n\n1. A?")), false);
  // A word that only starts like one asks.
  assert.equal(hasOpenQuestions(none("Open questions", "Nonexistent users: refuse them?")), true);
});

test("a first question that starts with a None word asks, in an issue and in a reply", () => {
  // Free text: the run waits with its form.
  const free1 = "1. **Keine Migration**: soll ich eine schreiben?";
  assert.deepEqual(
    replyQuestions(`<!-- needs-input -->\n## Brauche deine Eingabe\n\n${free1}`).items,
    [free("soll ich eine schreiben?", "Keine Migration")],
  );
  // The question is the section's first line: what follows "None" is read from it on.
  const questions = [
    "1. **Keine Migration**: soll ich eine schreiben?\n   - [ ] Ja\n   - [ ] Nein",
    "1. **Aucun test** : faut-il en ajouter ?\n   - [ ] Oui\n   - [ ] Non",
    "1. Ningún test cubre X: ¿añado uno?\n   - [ ] Sí\n   - [ ] No",
    "1. Rien ne couvre X : faut-il un test ?\n   - [ ] Oui\n   - [ ] Non",
  ];
  for (const list of questions) {
    for (const heading of ["Open questions", "Questions ouvertes"]) {
      const body = `## ${heading}\n\n${list}\n\nFrom the inbox: x`;
      assert.equal(hasOpenQuestions(body), true, `${heading}: ${list}`);
      assert.equal(parseQuestions(questionsSection(body)).items.length, 1);
    }
    const reply = replyQuestions(`<!-- needs-input -->\n## Needs your input\n\n${list}`);
    assert.equal(reply.items[0].options.length, 2, list);
  }
});

test("a run done but for a step only the maintainer can take asks it as a question", () => {
  // Issue #551: the pull request is ready, one blocker is left, asked rather than listed.
  const reply = [
    "<!-- needs-input -->",
    "## Needs your input",
    "",
    "The pull request is ready for review: only this step is left.",
    "",
    "1. **Release workflow**: add `deckhand-models` to `.github/workflows/release-workflow.yml` (Deckhand refused the edit: `packages: write`).",
    "   - [ ] Done, carry on",
    "   - [ ] Drop it",
    "",
    "### What I checked",
    "",
    "Tests pass; PR #537 is ready.",
  ].join("\n");
  assert.deepEqual(replyQuestions(reply).items, [
    {
      title: "Release workflow",
      text: "add `deckhand-models` to `.github/workflows/release-workflow.yml` (Deckhand refused the edit: `packages: write`).",
      options: [
        { label: "Done, carry on", recommended: false, checked: false },
        { label: "Drop it", recommended: false, checked: false },
      ],
    },
  ]);
  assert.equal(allTicked(replyQuestions(reply).items), false);
  assert.equal(outcome({ ok: true, text: reply }), "needs-input");
});

// An `issues` delivery on org/repo by `user`; `sender` defaults to them.
function issues(action, { user = "alice", type = "User", text = "", labels = [], ...more } = {}) {
  return {
    action,
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    issue: {
      number: 12,
      title: "An idea",
      state: "open",
      body: text,
      user: { login: user, type },
      labels: labels.map((name) => ({ name })),
    },
    sender: { login: user, type },
    ...more,
  };
}
const asks = "## Open questions\n\n1. Which one?";
const none = "## Open questions\n\nNone.";
const map = (action, opts, event = "issues", cfg = config) =>
  inputEvent(cfg, event, issues(action, opts), BOT);

test("an issue opened with open questions, by an allowed user or the App's bot, is labelled", () => {
  const change = { repo: "org/repo", key: "org/repo#12", number: 12, title: "An idea" };
  assert.deepEqual(map("opened", { text: asks }), {
    ...change,
    base: "trunk",
    label: true,
    by: "alice",
    track: true,
    questions: { items: [{ title: null, text: "Which one?", options: [] }], raw: "1. Which one?" },
  });
  // The bot's (an inbox run's): no user to check against the repo's.
  assert.equal(map("opened", { text: asks, user: BOT, type: "Bot" }).by, null);
  assert.equal(map("opened", { text: none }), null);
  assert.equal(map("opened", { text: "No section" }), null);
  // Opened with the label already: only listed.
  assert.deepEqual(map("opened", { text: asks, labels: ["Needs-Input"] }).label, undefined);
  assert.equal(map("opened", { text: asks, labels: ["needs-input"] }).track, true);
});

test("issues by others, on other repos, or with the label turned off are ignored", () => {
  assert.equal(map("opened", { text: asks, user: "mallory" }), null);
  assert.equal(map("opened", { text: asks, user: "other[bot]", type: "Bot" }), null);
  // A bot named like an allowed user isn't one.
  assert.equal(map("opened", { text: asks, user: "alice", type: "Bot" }), null);
  const elsewhere = issues("opened", { text: asks });
  elsewhere.repository.full_name = "org/other";
  assert.equal(inputEvent(config, "issues", elsewhere, BOT), null);
  const noApp = issues("opened", { text: asks });
  delete noApp.installation;
  assert.equal(inputEvent(config, "issues", noApp, BOT), null);
  const off = testConfig({ NEEDS_INPUT_LABEL: "" });
  assert.equal(map("opened", { text: asks }, "issues", off), null);
});

test("editing the section moves the label; other edits don't", () => {
  const edit = (from, to, labels, sender = { login: "bob", type: "User" }) =>
    map("edited", { text: to, labels, sender, changes: { body: { from } } });
  assert.equal(edit(none, asks, []).label, true);
  assert.equal(edit(none, asks, []).by, "bob");
  assert.equal(edit(asks, none, ["needs-input"]).label, false);
  assert.equal(edit(asks, none, ["needs-input"]).track, false);
  assert.equal(edit(asks, "Rewritten without it", ["needs-input"]).label, false);
  // Already as it should be: listed, with the questions as they are now.
  const still = edit(none, asks, ["needs-input"]);
  assert.deepEqual(
    [still.label, still.track, still.questions.raw],
    [undefined, true, "1. Which one?"],
  );
  assert.equal(edit(asks, none, []), null);
  // The section unchanged: a label removed by hand, or put by a run, stays as it is.
  assert.equal(edit(`Typo${asks}`, `Fixed${asks}`, []), null);
  assert.equal(edit("Typo", "Fixed", ["needs-input"]), null);
  // A title edit, or an edit by someone not allowed.
  assert.equal(map("edited", { text: asks, changes: { title: { from: "x" } } }), null);
  assert.equal(edit(none, asks, [], { login: "mallory", type: "User" }), null);
  // Theirs, or on someone else's issue, on an issue not labelled: not even read.
  const unread = (opts) => {
    const p = issues("edited", { text: asks, changes: { body: { from: none } }, ...opts });
    Object.defineProperty(p.issue, "body", { get: () => assert.fail("read") });
    return inputEvent(config, "issues", p, BOT);
  };
  assert.equal(unread({ sender: { login: "mallory", type: "User" } }), null);
  assert.equal(unread({ user: "mallory", sender: { login: "bob", type: "User" } }), null);
  assert.equal(edit(none, asks, [], { login: BOT, type: "Bot" }).by, null);
});

test("the dashboard follows the label, added or removed by anyone, and closed issues", () => {
  const label = (action, name, more) => map(action, { label: { name }, ...more });
  assert.equal(label("labeled", "needs-input", { user: "mallory" }).track, true);
  assert.equal(label("unlabeled", "needs-input").track, false);
  assert.equal(label("labeled", "bug"), null);
  assert.equal(map("closed").track, false);
  assert.equal(map("deleted").track, false);
  assert.equal(map("reopened", { labels: ["needs-input"] }).track, true);
  assert.equal(map("reopened"), null);
  assert.equal(map("assigned"), null);
  // Listed: with the questions of its body.
  const listed = label("labeled", "needs-input", { text: "## Open questions\n\n1. A?" });
  assert.deepEqual(listed.questions, { items: [free("A?")], raw: "1. A?" });
  assert.equal(label("labeled", "needs-input").questions, null);
  assert.equal(label("unlabeled", "needs-input").questions, undefined);
  // What a comment waiting for the answers starts on (waits.mjs).
  assert.equal(label("unlabeled", "needs-input").answered, true);
  // A run's questions there are set aside too (applyInput()).
  assert.deepEqual(label("unlabeled", "needs-input").unlabelled, { by: "alice", at: null });
  // When: the issue's `updated_at`, which a redelivery has from before a run since.
  const later = issues("unlabeled", { label: { name: "needs-input" } });
  later.issue.updated_at = "2026-10-31T12:00:00Z";
  const when = inputEvent(config, "issues", later, BOT).unlabelled.at;
  assert.equal(when, Date.parse("2026-10-31T12:00:00Z"));
  assert.equal(label("labeled", "needs-input").unlabelled, undefined);
  // Unless the App's bot took it off: a run starting, or a comment that may start nothing.
  const byBot = label("unlabeled", "needs-input", { sender: { login: BOT, type: "Bot" } });
  assert.deepEqual([byBot.track, byBot.answered, byBot.unlabelled], [false, true, undefined]);
  const closed = issues("unlabeled", { label: { name: "needs-input" } });
  closed.issue.state = "closed";
  assert.equal(inputEvent(config, "issues", closed, BOT).answered, undefined);
  for (const change of [map("closed"), label("labeled", "needs-input")]) {
    assert.equal(change.label, undefined);
  }
});

test("an allowed user's comment on a labelled issue takes the label off; Deckhand's don't", () => {
  const comment = (user, { labels = ["needs-input"], text = "1. A", pull = false } = {}) => {
    const p = issues("created", { labels });
    p.comment = {
      id: 9,
      body: text,
      user: { login: user, type: user.endsWith("]") ? "Bot" : "User" },
    };
    if (pull) p.issue.pull_request = { url: "x" };
    return inputEvent(config, "issue_comment", p, BOT);
  };
  assert.deepEqual(
    { label: comment("alice").label, by: comment("alice").by, track: comment("alice").track },
    { label: false, by: "alice", track: false },
  );
  // Its body: with the repo's `wait_for_answers`, a trigger line alone answers nothing.
  assert.equal(comment("alice", { text: "Deckhand" }).comment, "Deckhand");
  assert.equal(comment("alice", { labels: [] }), null);
  assert.equal(comment("mallory"), null);
  assert.equal(comment(BOT), null);
  assert.equal(comment("alice", { text: "Answer <!-- deckhand -->" }), null);
  // On a pull request: off, but not listed (a pull request's task key isn't its number).
  const pr = comment("alice", { pull: true });
  assert.equal(pr.label, false);
  assert.equal(pr.track, undefined);
  assert.equal(pr.title, null);
  assert.equal(pr.comment, undefined);
});

test("a pull request's label taken off, or put back, comes as a pull_request delivery", () => {
  const delivery = (more = {}) => ({
    action: "unlabeled",
    installation: { id: 1 },
    repository: { full_name: "org/repo", default_branch: "main" },
    pull_request: { number: 9, title: "A change", labels: [], updated_at: "2026-10-31T12:00:00Z" },
    label: { name: "needs-input" },
    sender: { login: "mallory", type: "User" },
    ...more,
  });
  assert.deepEqual(inputEvent(config, "pull_request", delivery(), BOT), {
    repo: "org/repo",
    key: "org/repo#pr-9",
    number: 9,
    title: null,
    base: "main",
    unlabelled: { by: "mallory", at: Date.parse("2026-10-31T12:00:00Z") },
  });
  // The App's bot taking it off: the listener's own doing, which answers nothing.
  const bot = delivery({ sender: { login: BOT, type: "Bot" } });
  assert.equal(inputEvent(config, "pull_request", bot, BOT), null);
  // Put back by someone else: its questions ask again. By the bot (a run asking): nothing.
  const back = inputEvent(config, "pull_request", delivery({ action: "labeled" }), BOT);
  assert.deepEqual(
    [back.relabelled, back.unlabelled],
    [{ by: "mallory", at: Date.parse("2026-10-31T12:00:00Z") }, undefined],
  );
  const asking = delivery({ action: "labeled", sender: { login: BOT, type: "Bot" } });
  assert.equal(inputEvent(config, "pull_request", asking, BOT), null);
  // Put back on a closed or merged pull request: its close still holds.
  const shut = delivery({ action: "labeled" });
  shut.pull_request = { ...shut.pull_request, state: "closed" };
  assert.equal(inputEvent(config, "pull_request", shut, BOT), null);
  // A redelivery (events.mjs replayedPull()): when it happened is the original payload's.
  const replayed = delivery({ replayed_updated_at: "2026-10-30T09:00:00Z" });
  const old = inputEvent(config, "pull_request", replayed, BOT).unlabelled.at;
  assert.equal(old, Date.parse("2026-10-30T09:00:00Z"));
  // Another label, another action, another repo, no installation, or no label configured.
  assert.equal(inputEvent(config, "pull_request", delivery({ label: { name: "bug" } }), BOT), null);
  assert.equal(inputEvent(config, "pull_request", delivery({ action: "edited" }), BOT), null);
  const elsewhere = delivery({ repository: { full_name: "evil/repo" } });
  assert.equal(inputEvent(config, "pull_request", elsewhere, BOT), null);
  assert.equal(inputEvent(config, "pull_request", delivery({ installation: null }), BOT), null);
  const off = { ...config, needsInputLabel: "" };
  assert.equal(inputEvent(off, "pull_request", delivery(), BOT), null);
});

// The listener's state and services applyInput() touches, each call kept.
function inputCtx(
  settings = { users: ["alice", "bob"], trigger: "deckhand", waitForAnswers: true },
) {
  const calls = [];
  const ctx = {
    config,
    log: (line) => calls.push(["log", line]),
    skip: (why) => (calls.push(["skip", why]), null),
    titles: { set: (key, title) => calls.push(["title", key, title]) },
    repoSettings: async () => ({ settings, errors: [] }),
    label: async (repo, number, on) => (calls.push(["label", number, on]), new Response(null)),
    inputs: {
      set: (key, track) => calls.push(["track", key, track]),
      update: (key, questions, ignored) =>
        calls.push(["update", key, ...(ignored === undefined ? [] : [ignored])]),
    },
    waits: { answered: async (repo, number) => calls.push(["answered", number]) },
  };
  return { ctx, calls };
}

test("applyInput: the label and the list follow the change, by the repo's own users", async () => {
  const change = { repo: "org/repo", key: "org/repo#3", number: 3, base: "main", label: false };
  const { ctx, calls } = inputCtx();
  await applyInput(ctx, { ...change, by: "bob", track: false, comment: "Yes, Postgres." });
  assert.deepEqual(
    calls.filter(([what]) => what !== "log"),
    [
      ["label", 3, false],
      ["track", "org/repo#3", false],
    ],
  );
  // Not among the repo's users: nothing changes.
  const narrow = inputCtx({ users: ["alice"], trigger: "deckhand", waitForAnswers: true });
  await applyInput(narrow.ctx, { ...change, by: "bob", track: false, comment: "Yes." });
  assert.deepEqual(
    narrow.calls.map(([what]) => what),
    ["skip"],
  );
  // Ticks by someone the repo's users narrow out: ignored for wait_for_answers too.
  const ticks = inputCtx({ users: ["alice"], trigger: "deckhand", waitForAnswers: true });
  await applyInput(ticks.ctx, { ...change, by: "bob", track: false, ticked: true });
  assert.deepEqual(
    ticks.calls.map(([what, , ignored]) => [what, ignored]),
    [
      ["update", true],
      ["skip", undefined],
    ],
  );
  // A trigger line alone answers nothing while the repo waits for answers.
  const trigger = inputCtx();
  await applyInput(trigger.ctx, { ...change, by: "bob", track: false, comment: "Deckhand" });
  assert.deepEqual(
    trigger.calls.map(([what]) => what),
    ["skip"],
  );
  // The label taken off by hand: whatever waited for the answers starts.
  const off = inputCtx();
  await applyInput(off.ctx, { ...change, label: undefined, track: false, answered: true });
  assert.deepEqual(off.calls.at(-1), ["answered", 3]);
  // The questions of the task's last run, if it asked, are set aside: it no longer waits.
  const aside = inputCtx();
  aside.ctx.runs = [{ id: "r2", key: "org/repo#3", status: "needs-input" }];
  aside.ctx.dismissals = {
    setAsideOn: (runs, key, by, at) => {
      aside.calls.push(["aside", runs.length, key, by, at]);
      return "org/repo#3";
    },
  };
  const unlabelled = { by: "carol", at: 5 };
  await applyInput(aside.ctx, { ...change, label: undefined, track: false, unlabelled });
  assert.deepEqual(
    aside.calls.filter(([what]) => what === "aside"),
    [["aside", 1, "org/repo#3", "carol", 5]],
  );
  // A pull request's label put back: they wait again.
  aside.ctx.dismissals.restoreOn = (runs, key, at) => (aside.calls.push(["back", key, at]), key);
  const pr = { repo: "org/repo", key: "org/repo#pr-9", number: 9, title: null, base: "main" };
  await applyInput(aside.ctx, { ...pr, relabelled: { by: "carol", at: 6 } });
  assert.deepEqual(aside.calls.at(-2), ["back", "org/repo#pr-9", 6]);
  assert.match(aside.calls.at(-1)[1], /org\/repo#pr-9: label put back/);
});

const ticked = (a, b) =>
  `## Open questions\n\n1. **A**: which?\n   - [${a}] X (recommended)\n   - [ ] Y\n2. B?\n   - [ ] Z\n   - [${b}] W`;

test("parsed questions: each option ticked or not, [x] and [X] alike", () => {
  const options = (text) =>
    parseQuestions(questionsSection(text)).items.map((q) => q.options.map((o) => o.checked));
  assert.deepEqual(options(ticked("x", "X")), [
    [true, false],
    [false, true],
  ]);
  assert.deepEqual(options(ticked(" ", " ")), [
    [false, false],
    [false, false],
  ]);
});

test("allTicked: a box in every question, none of them free text", () => {
  const all = (text) => allTicked(parseQuestions(questionsSection(text)));
  assert.equal(all(ticked("x", "x")), true);
  assert.equal(all(ticked("x", " ")), false);
  assert.equal(all(ticked(" ", " ")), false);
  // A free-text question needs a comment, ticks or not.
  assert.equal(all(`${ticked("x", "x")}\n3. Anything else?`), false);
  assert.equal(all(none), false);
  assert.equal(allTicked(null), false);
  assert.equal(stillAsks(ticked("x", "x")), false);
  assert.equal(stillAsks(ticked("x", " ")), true);
  assert.equal(stillAsks(none), false);
});

test("the bot's ticks answer nothing: its edits of a fully ticked section leave the label", () => {
  const sender = { login: BOT, type: "Bot" };
  const edit = (from, to, labels) =>
    map("edited", { text: to, labels, sender, changes: { body: { from } } });
  // The bot ticking the last box: the label stays, the dashboard shows the ticks.
  const own = edit(ticked("x", " "), ticked("x", "x"), ["needs-input"]);
  assert.deepEqual([own.label, own.track, own.answered], [undefined, true, undefined]);
  assert.equal(own.questions.items[1].options[1].checked, true);
  // Kept with the entry, so wait_for_answers doesn't take them for answers either.
  assert.equal(own.ignoredTicks, true);
  const person = map("edited", {
    text: ticked("x", " "),
    labels: ["needs-input"],
    changes: { body: { from: ticked("x", "x") } },
  });
  assert.equal(person.ignoredTicks, false);
  // Rewording a section ticked at open: still labelled.
  const reworded = edit(ticked("x", "x"), ticked("x", "x").replace("B?", "Bee?"), ["needs-input"]);
  assert.equal(reworded.label, undefined);
  // Ticked by a person, unlabelled: the bot's later edit doesn't label it again.
  assert.equal(edit(ticked("x", "x"), ticked("x", "x").replace("B?", "Bee?"), []), null);
  // "None", or unticking: as for anyone.
  assert.equal(edit(ticked("x", "x"), none, ["needs-input"]).label, false);
  assert.equal(edit(ticked("x", "x"), ticked(" ", "x"), []).label, true);
});

test("ticking every question's box answers them; unticking asks again", () => {
  const edit = (from, to, labels, sender = { login: "bob", type: "User" }) =>
    map("edited", { text: to, labels, sender, changes: { body: { from } } });
  const done = edit(ticked("x", " "), ticked("x", "x"), ["needs-input"]);
  assert.deepEqual([done.label, done.track, done.answered, done.by], [false, false, true, "bob"]);
  // Partly ticked, or a free-text question left: the label stays, the form shows the ticks.
  const partly = edit(ticked(" ", " "), ticked("x", " "), ["needs-input"]);
  assert.equal(partly.label, undefined);
  assert.equal(partly.questions.items[0].options[0].checked, true);
  const free = `${ticked("x", "x")}\n3. Anything else?`;
  assert.equal(edit(ticked("x", " "), free, ["needs-input"]).label, undefined);
  // Its ticks took the label off: a refusal (not among the repo's users) keeps them ignored.
  assert.equal(done.ticked, true);
  // Someone not allowed ticking them: the label stays, and their ticks are ignored for
  // wait_for_answers too.
  const mallory = { login: "mallory", type: "User" };
  const theirs = edit(ticked("x", " "), ticked("x", "x"), ["needs-input"], mallory);
  assert.deepEqual([theirs.label, theirs.by, theirs.ignoredTicks], [undefined, undefined, true]);
  assert.equal(edit(ticked("x", " "), ticked("x", "x"), [], mallory), null);
  assert.equal(edit(ticked(" ", " "), ticked("x", " "), ["needs-input"], mallory), null);
  // Unticked again: labelled again.
  const again = edit(ticked("x", "x"), ticked(" ", "x"), []);
  assert.deepEqual([again.label, again.track], [true, true]);
  // Opened with every box ticked by an allowed user: nothing to wait for. By the App's bot (an
  // inbox run that ticked its own picks): its ticks answer nothing.
  assert.equal(map("opened", { text: ticked("x", "x") }), null);
  const bot = map("opened", { text: ticked("x", "x"), user: BOT, type: "Bot" });
  assert.deepEqual([bot.label, bot.by, bot.track], [true, null, true]);
  // A closed issue releases nothing.
  const closed = issues("edited", {
    text: ticked("x", "x"),
    labels: ["needs-input"],
    changes: { body: { from: ticked(" ", "x") } },
  });
  closed.issue.state = "closed";
  assert.equal(inputEvent(config, "issues", closed, BOT).answered, false);
  // A closed issue still labelled, its section edited: not listed again.
  for (const [from, to, sender] of [
    [ticked(" ", " "), ticked("x", " ")],
    [ticked("x", " "), ticked("x", "x"), { login: "mallory", type: "User" }],
  ]) {
    const p = issues("edited", {
      text: to,
      labels: ["needs-input"],
      changes: { body: { from } },
      ...(sender && { sender }),
    });
    p.issue.state = "closed";
    assert.equal(inputEvent(config, "issues", p, BOT).track, false);
  }
});

// An `issue_comment edited` delivery: `sender` ticking boxes in a comment by `author`.
function tick(from, to, { author = BOT, sender = "alice", pull = false } = {}) {
  const p = issues("edited", { sender: { login: sender, type: "User" } });
  const bot = author.endsWith("]");
  p.comment = { id: 9, body: to, user: { login: author, type: bot ? "Bot" : "User" } };
  p.changes = { body: { from } };
  if (pull) p.issue.pull_request = { url: "x" };
  return inputEvent(config, "issue_comment", p, BOT);
}
const reply = (a, b) =>
  `<!-- needs-input -->\n## Needs your input\n\n### Open questions\n\n${ticked(a, b).replace("## Open questions\n\n", "")}\n\n### Checked\n\nThe code.\n\n<sub>🤖 Claude</sub>\n<!-- deckhand -->`;

test("an issue the start's listing missed, edited while it is looked up: the edit's questions, its first `since`", async (t) => {
  const parsed = (text) => parseQuestions(questionsSection(text));
  // inputs.mjs's own, between sync() and keep(): #12 was labelled at 1, the listing missed it.
  const setup = async (settings) => {
    let clock = 1;
    const inputs = createInputs({
      listLabelled: async () => [],
      now: () => clock,
    });
    inputs.set("org/repo#12", true, parsed(ticked(" ", " ")));
    clock = 100;
    await inputs.sync(["org/repo"]);
    assert.equal(inputs.has("org/repo#12"), false);
    const { ctx } = inputCtx(settings);
    ctx.inputs = inputs;
    return { inputs, ctx };
  };
  const edit = (from, to, login) =>
    inputEvent(
      config,
      "issues",
      issues("edited", {
        text: to,
        labels: ["needs-input"],
        sender: { login, type: "User" },
        changes: { body: { from } },
      }),
      BOT,
    );
  // Alice ticks a box: the delivery lists it again, as it was since 1, its questions the edit's.
  const edited = await setup();
  await applyInput(edited.ctx, edit(ticked(" ", " "), ticked("x", " "), "alice"));
  assert.deepEqual(edited.inputs.list(), [
    { key: "org/repo#12", repo: "org/repo", since: 1, questions: parsed(ticked("x", " ")) },
  ]);
  // The lookup answers after: the delivery's word stands.
  assert.equal(edited.inputs.keep("org/repo#12", parsed(ticked(" ", " "))), false);
  assert.deepEqual(edited.inputs.list()[0].questions, parsed(ticked("x", " ")));
  // Bob, not among the repo's users, ticks every box: his ticks answer nothing, and the lookup
  // still says what the body asks now.
  const ignored = await setup({ users: ["alice"], trigger: "deckhand", waitForAnswers: true });
  await applyInput(ignored.ctx, edit(ticked("x", " "), ticked("x", "x"), "bob"));
  assert.equal(ignored.inputs.has("org/repo#12"), false);
  assert.equal(ignored.inputs.keep("org/repo#12", parsed(ticked("x", "x"))), true);
  assert.deepEqual(ignored.inputs.list(), [
    { key: "org/repo#12", repo: "org/repo", since: 1, questions: parsed(ticked("x", "x")) },
  ]);
  assert.equal(ignored.inputs.ticksIgnored("org/repo#12"), true);
});

test("ticking every question's box in a run's reply answers it, as a reply would", () => {
  const done = tick(reply("x", " "), reply("x", "x"));
  // The boxes as the edit left them: which are a person's is work.mjs ticked()'s.
  const checks = done.reply.items.map((q) => q.options.map((o) => o.checked));
  assert.deepEqual(checks, [
    [true, false],
    [false, true],
  ]);
  assert.equal(done.reply.pr, false);
  assert.equal(done.reply.items.length, 2);
  assert.equal(done.by, "alice");
  assert.equal(done.label, undefined);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { pull: true }).reply.pr, true);
  // A reply that came fully ticked (the agent's own ticks): a person's tick still goes on.
  assert.ok(tick(reply("x", "x"), reply("x", "x").replace("[ ] Z", "[x] Z")));
  // Partly ticked, the ticks unchanged, someone not allowed, or a comment that isn't the App's.
  assert.equal(tick(reply(" ", " "), reply("x", " ")), null);
  assert.equal(tick(reply("x", "x"), reply("x", "x").replace("The code", "Code")), null);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { sender: "mallory" }), null);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { author: "bob" }), null);
  assert.equal(tick(reply("x", " "), reply("x", "x"), { author: "other[bot]" }), null);
  // Not a reply that stopped to ask.
  const plain = (s) => s.replace("<!-- needs-input -->", "");
  assert.equal(tick(plain(reply("x", " ")), plain(reply("x", "x"))), null);
});

test("applyInput: a run's ticked reply goes on through the work area, refusals logged", async () => {
  const { ctx, calls } = inputCtx();
  const asked = [];
  ctx.workApi = { ticked: async (...args) => (asked.push(args), "Answers sent: #12 continues.") };
  const change = tick(reply("x", " "), reply("x", "x"));
  await applyInput(ctx, change);
  assert.deepEqual(asked, [
    ["org/repo", "alice", { number: 12, pr: false, items: change.reply.items }],
  ]);
  assert.deepEqual(calls.at(-1), ["log", "org/repo#12: Answers sent: #12 continues."]);
  ctx.workApi = {
    ticked: async () => {
      throw new Refused(409, "#12 is closed.");
    },
  };
  await applyInput(ctx, change);
  assert.deepEqual(calls.at(-1), ["log", "org/repo#12: ticks: #12 is closed."]);
});
