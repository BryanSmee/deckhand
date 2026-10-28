// A task waiting for input, answered from its page: the form for questions in the set format,
// one text box for the others, and the listener's refusal (fetch mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import questionsCss from "./Questions.module.css?raw";
import { makeState, mockApi } from "./testUtils";
import type { Task } from "./types";

const state = makeState();
const ASKING = "acme/api#138";

let api: ReturnType<typeof mockApi>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  api = mockApi();
  api.answer = () => ({ message: "Answers sent: #138 continues." });
  refresh = vi.fn<() => Promise<void>>(async () => {});
  history.replaceState(null, "", `#/?task=${encodeURIComponent(ASKING)}`);
});

// The fixture, with the asking task changed by `change`.
const show = (change: (t: Task) => Task = (t) => t) => {
  const tasks = state.tasks.map((t) => (t.key === ASKING ? change(t) : t));
  render(<Dashboard state={{ ...state, tasks }} error={null} refresh={refresh} />);
  return screen.queryByRole("form", { name: "Open questions" }) as HTMLElement;
};

test("parsed questions: one option card each, the pick in advance, a note per question", async () => {
  const form = show();
  const first = within(form).getByRole("group", { name: "1. Debounce" });
  expect(within(first).getByText(/How long should the search wait/)).toBeTruthy();
  const [fast, slow] = within(first).getAllByRole("radio") as HTMLInputElement[];
  // The agent's pick, marked and picked: one tap accepts it.
  const pick = within(first).getByText("Recommended");
  expect(pick.closest("label")?.textContent).toMatch(/^300 ms/);
  expect([fast.checked, slow.checked]).toEqual([false, true]);
  // One option per question: picking another drops it; picked again, none is.
  fireEvent.click(fast);
  expect([fast.checked, slow.checked]).toEqual([true, false]);
  fireEvent.click(fast);
  expect([fast.checked, slow.checked]).toEqual([false, false]);
  fireEvent.click(fast);
  // A question without a title is named by its text; one without options is a text field.
  const second = within(form).getByRole("group", { name: /^2\. Should a search in flight/ });
  const free = within(form).getByRole("group", { name: "3. Empty state" });
  expect(within(free).queryAllByRole("radio")).toHaveLength(0);

  fireEvent.input(within(form).getByRole("textbox", { name: "Note on question 1" }), {
    target: { value: "Try 250 if it lags" },
  });
  // Partial answers can go: the form says which are left.
  // The pick taken back.
  fireEvent.click(within(second).getByRole("radio", { name: /Yes, abort it/ }));
  expect(within(form).getByText(/2 left blank: the run sees which/)).toBeTruthy();
  fireEvent.input(within(free).getByRole("textbox", { name: "Answer to question 3" }), {
    target: { value: "No results" },
  });
  expect(within(form).getByText(/1 left blank: the run sees which/)).toBeTruthy();
  const send = within(form).getByRole("button", { name: "Send answers" });

  // Held until the test lets it go.
  const release = api.hold();
  fireEvent.click(send);
  // Disabled while sending.
  await waitFor(() => expect(send.getAttribute("aria-busy")).toBe("true"));
  expect(send.textContent).toContain("Sending…");
  expect(within(first).getAllByRole("radio")[0].matches(":disabled")).toBe(true);
  release();
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Answers sent: #138 continues.",
  );
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: {
        number: 138,
        answers: [
          { options: [0], text: "Try 250 if it lags" },
          { options: [], text: "" },
          { options: [], text: "No results" },
        ],
      },
    },
  ]);
  // api/state is read again: the task's new state shows.
  expect(refresh).toHaveBeenCalled();
});

test("questions not in the format: shown as written, one text box", async () => {
  const raw = "1. Should it be fast or cheap? I'd go cheap.\n2. Which colour?";
  const form = show((t) => ({ ...t, questions: { source: "issue", items: null, raw } }));
  expect(within(form).queryAllByRole("radio")).toHaveLength(0);
  expect(within(form).getByText(/Should it be fast or cheap\?/).textContent).toBe(raw);
  fireEvent.input(within(form).getByRole("textbox", { name: "Answers" }), {
    target: { value: "1. cheap 2. blue" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Send answers" }));
  await waitFor(() =>
    expect(api.posted).toEqual([
      { url: "api/repos/acme/api/answer", body: { number: 138, text: "1. cheap 2. blue" } },
    ]),
  );
});

test("a refusal is shown as the listener says it, and the answers stay to send again", async () => {
  api.answer = () => Response.json({ error: "#138 isn't waiting for answers." }, { status: 409 });
  const form = show();
  const box = within(form).getByRole("textbox", { name: "Answer to question 3" });
  fireEvent.input(box, { target: { value: "No results" } });
  fireEvent.click(within(form).getByRole("button", { name: "Send answers" }));
  expect(await within(form).findByRole("alert")).toHaveProperty(
    "textContent",
    "#138 isn't waiting for answers.",
  );
  expect((box as HTMLTextAreaElement).value).toBe("No results");
  expect(
    (within(form).getByRole("button", { name: "Send answers" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});

test("a pull request's own task sends `pr`; a task not waiting for input has no form", async () => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent("acme/api#pr-138")}`);
  const form = show((t) => ({ ...t, key: "acme/api#pr-138", kind: "pr" }));
  fireEvent.input(within(form).getByRole("textbox", { name: "Answer to question 3" }), {
    target: { value: "No results" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Send answers" }));
  await waitFor(() =>
    expect(api.posted).toMatchObject([
      { url: "api/repos/acme/api/answer", body: { number: 138, pr: true } },
    ]),
  );
  document.body.replaceChildren();
  history.replaceState(null, "", `#/?task=${encodeURIComponent(ASKING)}`);
  expect(show((t) => ({ ...t, state: "done" }))).toBeNull();
});

// jsdom does no layout, so the rule itself: on the task's page, the run's outcome and log go on
// the page's scroll below the form, and a form that shrinks is squeezed to its Send answers
// (#361). A long list scrolls inside it instead, capped by the viewport.
test("the form on the task's page keeps its height next to a run", () => {
  const rule = (selector: string) => {
    const css = `\n${questionsCss}`;
    const start = css.indexOf(`\n${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  const form = rule(".form");
  expect(form).toMatch(/\bflex: none;/);
  expect(form).toMatch(/max-height: [^;]*\b\d+vh\b/);
  expect(form).toMatch(/overflow-y: auto;/);
  // Without a run, the form still fills the page.
  expect(rule(".form:last-child")).toMatch(/\bflex: 1;/);
});

// The fixture's questions with the first option of question 1 ticked, from `source`.
const ticked = (source: "issue" | "run") => (t: Task) => {
  const items = t.questions!.items!.map((q, i) =>
    i === 0 ? { ...q, options: q.options.map((o, j) => ({ ...o, checked: j === 0 })) } : q,
  );
  return { ...t, questions: { ...t.questions!, source, items } };
};

test("a run's own ticks are the agent's: its recommended option is picked, not them", () => {
  const form = show(ticked("run"));
  const first = within(form).getByRole("group", { name: "1. Debounce" });
  const [fast, slow] = within(first).getAllByRole("radio") as HTMLInputElement[];
  expect([fast.checked, slow.checked]).toEqual([false, true]);
});

test("boxes ticked in the issue are picked in advance, in place of the recommended option", () => {
  const form = show(ticked("issue"));
  const first = within(form).getByRole("group", { name: "1. Debounce" });
  const [fast, slow] = within(first).getAllByRole("radio") as HTMLInputElement[];
  expect([fast.checked, slow.checked]).toEqual([true, false]);
  // Only the first is ticked: the second still starts from its recommended option.
  const second = within(form).getByRole("group", { name: /^2\. Should a search in flight/ });
  const yes = within(second).getByRole("radio", { name: /Yes, abort it/ }) as HTMLInputElement;
  expect(yes.checked).toBe(true);
});
