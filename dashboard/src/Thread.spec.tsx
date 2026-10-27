// A discussion task's page: its thread read from the listener, Deckhand's answers and the
// dashboard's posts shown as such, a reply in a thread and a new comment sent (fetch mocked),
// the run's log a click away.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { makeState, mockApi } from "./testUtils";
import type { Thread } from "./types";

const state = makeState();
const KEY = "acme/notes#discussion-8";

const post = (id: string, author: string | null, body: string, deckhand = false) => ({
  id,
  url: `https://github.com/acme/notes/discussions/8#${id}`,
  author,
  deckhand,
  at: new Date(state.now - 120_000).toISOString(),
  body,
});

let thread: Thread;
let api: ReturnType<typeof mockApi>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  thread = {
    number: 8,
    title: "Weekly digest?",
    url: "https://github.com/acme/notes/discussions/8",
    post: post("D_8", "alice", "Should notes send a weekly digest?"),
    comments: [
      {
        ...post("DC_1", "deckhand", "A digest issue each Monday, or a discussion?", true),
        replies: [post("DC_2", "alice", "An issue, please.")],
        more: 0,
      },
    ],
    more: 2,
    readAt: state.now,
  };
  // Read anew each time: a comment pushed to it shows with the next read.
  api = mockApi({ "api/repos/acme/notes/discussions/8": () => thread });
  api.answer = () => ({ message: "Sent to discussion #8.", url: "u" });
  refresh = vi.fn<() => Promise<void>>(async () => {});
});

const show = () => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent(KEY)}`);
  render(<Dashboard state={state} error={null} refresh={refresh} />);
};

test("the thread: the opening post, Deckhand's answer, the replies, older comments on GitHub", async () => {
  show();
  const view = await screen.findByRole("region", { name: "Discussion" });
  const posts = within(view).getAllByRole("article");
  expect(posts.map((p) => p.querySelector("b")!.textContent)).toEqual([
    "@alice",
    "Deckhand",
    "@alice",
  ]);
  expect(posts[1].textContent).toContain("A digest issue each Monday");
  expect(within(view).getByText(/2 earlier comments/)).toBeTruthy();
  // The run's log, a tab away.
  fireEvent.click(screen.getAllByRole("tab")[1]);
  expect(screen.queryByRole("region", { name: "Discussion" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Thread" }));
  await screen.findByRole("region", { name: "Discussion" });
});

test("a reply in a thread, then a new comment: api.posted, the thread and the state read again", async () => {
  show();
  const view = await screen.findByRole("region", { name: "Discussion" });
  fireEvent.click(within(view).getByRole("button", { name: "Reply" }));
  const reply = within(view).getByRole("form", { name: "Reply" });
  fireEvent.input(within(reply).getByRole("textbox"), { target: { value: "Mondays it is" } });
  // A comment written on GitHub meanwhile shows up with the next read.
  thread.comments[0].replies.push(post("DC_3", "bob", "Seconded."));
  fireEvent.click(within(reply).getByRole("button", { name: "Reply" }));
  await waitFor(() => expect(within(view).getByText("Seconded.")).toBeTruthy());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/notes/discussions/8/comments",
      body: { text: "Mondays it is", replyTo: "DC_1" },
    },
  ]);
  expect(refresh).toHaveBeenCalled();
  expect(within(view).queryByRole("form", { name: "Reply" })).toBeNull();

  const comment = within(view).getByRole("form", { name: "Comment" });
  fireEvent.input(within(comment).getByRole("textbox"), { target: { value: "And email?" } });
  fireEvent.click(within(comment).getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(api.posted).toHaveLength(2));
  expect(api.posted[1].body).toEqual({ text: "And email?" });
});

test("a refusal: the listener's message, the text kept", async () => {
  api.answer = () =>
    Response.json({ error: "acme/notes has no discussions category." }, { status: 409 });
  show();
  const view = await screen.findByRole("region", { name: "Discussion" });
  const comment = within(view).getByRole("form", { name: "Comment" });
  fireEvent.input(within(comment).getByRole("textbox"), { target: { value: "Hello" } });
  fireEvent.click(within(comment).getByRole("button", { name: "Comment" }));
  await waitFor(() =>
    expect(within(comment).getByRole("alert").textContent).toBe(
      "acme/notes has no discussions category.",
    ),
  );
  expect((within(comment).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Hello");
  expect(refresh).not.toHaveBeenCalled();
});
