// A chat's agent's request for more permissions, in its conversation (#479): what it asks for,
// its reason as text (never markup), when an approval applies, and the three answers posted to
// api/chats/<id>/requests/<request>.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { PermissionCard } from "./PermissionCard";
import { chatNote } from "./chatModel";
import { makeChat, mockApi } from "./testUtils";
import type { PermissionRequest } from "./types";

const REQUEST: PermissionRequest = {
  id: "00112233aabbccdd",
  kind: "host",
  what: "registry.npmjs.org",
  reason: "npm ci needs <b>the registry</b> [link](https://evil.example)",
  live: true,
  state: "pending",
  message: null,
  at: 0,
  expiresAt: 10 * 60_000,
};
const URL = "api/chats/0123456789abcdef/requests/00112233aabbccdd";

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({ [`POST ${URL}`]: () => ({ request: REQUEST, chat: makeChat() }) });
});

test("what it asks for, its reason as plain text, and how long before no answer denies it", () => {
  render(
    <PermissionCard chatId="0123456789abcdef" request={REQUEST} now={60_000} onChat={() => {}} />,
  );
  expect(screen.getByRole("region", { name: "The agent asks for a host" })).toBeTruthy();
  expect(screen.getByText("registry.npmjs.org")).toBeTruthy();
  // The agent's words as they are: no element, no link made of them.
  expect(screen.getByText(REQUEST.reason)).toBeTruthy();
  expect(document.querySelector("b")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/Applies to its sandbox at once\. Denied in 9 minutes/)).toBeTruthy();
});

test("one that applies at the next start says so", () => {
  const engine = { ...REQUEST, kind: "engine" as const, what: "a container engine", live: false };
  render(<PermissionCard chatId="0123456789abcdef" request={engine} now={0} onChat={() => {}} />);
  expect(screen.getByText(/Applies when its sandbox starts again/)).toBeTruthy();
});

test.each([
  ["Approve once", "once"],
  ["Approve for this chat", "chat"],
  ["Deny", "deny"],
])("%s posts its answer, and the chat as the listener answered goes up", async (label, answer) => {
  const onChat = vi.fn();
  render(<PermissionCard chatId="0123456789abcdef" request={REQUEST} now={0} onChat={onChat} />);
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(onChat).toHaveBeenCalled());
  expect(api.posted).toEqual([{ url: URL, body: { answer } }]);
});

test("a refused answer is said, the request kept", async () => {
  api.routes[`POST ${URL}`] = () =>
    Response.json({ error: "This request has its answer already." }, { status: 409 });
  const onChat = vi.fn();
  render(<PermissionCard chatId="0123456789abcdef" request={REQUEST} now={0} onChat={onChat} />);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This request has its answer already.",
  );
  expect(onChat).not.toHaveBeenCalled();
});

test("the composer's line says the agent waits for an answer", () => {
  const running = { status: "running" as const, phase: "work" } as never;
  const chat = makeChat({ status: "running", runs: [running], requests: [REQUEST] });
  expect(chatNote(chat)).toBe("The agent waits for your answer to its request above.");
});
