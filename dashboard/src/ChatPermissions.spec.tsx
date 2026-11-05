// A chat's permissions panel against a fake api/chats/<id>/permissions: what the ceiling greys
// out and why, toggles saved as a profile (null for "everything allowed"), a refusal's reasons,
// and "Restart now" for a sandbox going.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { ChatPermissions } from "./ChatPermissions";
import { mockApi } from "./testUtils";
import type { ChatPermissions as Permissions } from "./types";

const row = (name: string, allowed = true, reason: string | null = null, needs = ["pull"]) => ({
  name,
  what: `what ${name} gives`,
  needs,
  allowed,
  required: false,
  reason,
});

const VIEW: Permissions = {
  profile: { github: "read", capabilities: null, hosts: null, mounts: null },
  ceiling: {
    capabilities: [
      { ...row("pull", true, "a chat works in a clone of the repository", []), required: true },
      row("push", false, "chats only read GitHub for now"),
      row("setup"),
      row("docker", false, "the operator's policies don't grant docker to this repository"),
      row("read:issues"),
    ],
    hosts: ["registry.npmjs.org", "pypi.org"],
    mounts: [{ target: "/srv/data", writable: false, reason: "the operator grants it read-only" }],
    github: [
      { level: "read", allowed: true, reason: null },
      { level: "comment", allowed: false, reason: "chats only read GitHub for now" },
      { level: "push", allowed: false, reason: "chats only read GitHub for now" },
    ],
  },
  effective: {
    github: "read",
    capabilities: ["pull", "setup", "read:issues"],
    hosts: ["registry.npmjs.org", "pypi.org"],
    mounts: [{ target: "/srv/data", readOnly: true }],
  },
  errors: [],
  running: false,
};

const URL = "api/chats/0123456789abcdef/permissions";
let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({ [URL]: () => VIEW });
});

const toggle = (name: RegExp) => screen.getByRole("switch", { name });

test("what the ceiling doesn't allow is greyed out, with its reason; what is required can't be turned off", async () => {
  render(<ChatPermissions chatId="0123456789abcdef" />);
  expect(await screen.findByRole("heading", { name: "Permissions" })).toBeTruthy();
  const docker = toggle(/Container engine/);
  expect(docker.hasAttribute("disabled")).toBe(true);
  expect((docker as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(/don't grant docker to this repository/)).toBeTruthy();
  const pull = toggle(/The repository's code/) as HTMLInputElement;
  expect(pull.disabled && pull.checked).toBe(true);
  // `push` is the GitHub level's: no toggle of its own.
  expect(screen.queryByRole("switch", { name: /push/ })).toBeNull();
  expect(screen.getByRole("radio", { name: /Comment on issues/ }).hasAttribute("disabled")).toBe(
    true,
  );
  expect((screen.getByRole("radio", { name: /Read only/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Read-only: the operator grants it read-only/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
});

test("toggles saved as a profile: what is all on stays null, so later grants are on too", async () => {
  api.answer = () => ({
    ...VIEW,
    profile: { ...VIEW.profile, hosts: ["pypi.org"], capabilities: ["pull", "read:issues"] },
    effective: { ...VIEW.effective, hosts: ["pypi.org"], capabilities: ["pull", "read:issues"] },
  });
  render(<ChatPermissions chatId="0123456789abcdef" />);
  fireEvent.click(await screen.findByRole("switch", { name: /registry\.npmjs\.org/ }));
  fireEvent.click(toggle(/Setup command/));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/The next message starts the sandbox with these permissions/);
  expect(api.posted).toEqual([
    {
      url: URL,
      body: {
        profile: {
          github: "read",
          capabilities: ["pull", "read:issues"],
          hosts: ["pypi.org"],
          mounts: null,
        },
      },
    },
  ]);
});

test("a profile refused: each reason listed, nothing saved", async () => {
  api.answer = () =>
    Response.json(
      {
        error: "This profile goes beyond what the chat may get: …",
        errors: ["`pypi.org`: not among the hosts the operator grants this repository"],
      },
      { status: 422 },
    );
  render(<ChatPermissions chatId="0123456789abcdef" />);
  fireEvent.click(await screen.findByRole("switch", { name: /pypi\.org/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Not saved: this goes beyond what the chat may get/)).toBeTruthy();
  expect(screen.getByText(/not among the hosts the operator grants/)).toBeTruthy();
});

test("a sandbox going keeps its permissions: Restart now stops it, its session kept", async () => {
  api.routes[URL] = () => ({ ...VIEW, running: true });
  api.answer = () => ({ message: "Its sandbox stops once its agent has answered." });
  render(<ChatPermissions chatId="0123456789abcdef" />);
  fireEvent.click(await screen.findByRole("button", { name: "Restart now" }));
  await screen.findByText("Its sandbox stops once its agent has answered.");
  expect(api.posted.map((p) => p.url)).toEqual(["api/chats/0123456789abcdef/restart"]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull());
});

test("what would stop the next run whatever the profile, and a panel that can't be read", async () => {
  api.routes[URL] = () => ({ ...VIEW, errors: ["a chat run needs pull"] });
  const { unmount } = render(<ChatPermissions chatId="0123456789abcdef" />);
  expect(await screen.findByText(/next run wouldn't start/)).toBeTruthy();
  unmount();
  api.routes[URL] = () => Response.json({ error: "No such chat." }, { status: 404 });
  render(<ChatPermissions chatId="0123456789abcdef" />);
  expect((await screen.findByRole("alert")).textContent).toContain("No such chat.");
});

test("with the open internet on, the host toggles have no effect: greyed out, and said", async () => {
  api.routes[URL] = () => ({
    ...VIEW,
    ceiling: { ...VIEW.ceiling, capabilities: [...VIEW.ceiling.capabilities, row("internet")] },
    effective: { ...VIEW.effective, capabilities: [...VIEW.effective.capabilities, "internet"] },
  });
  render(<ChatPermissions chatId="0123456789abcdef" />);
  expect((await screen.findByRole("switch", { name: /pypi\.org/ })).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByText(/reaches any public host/)).toBeTruthy();
});
