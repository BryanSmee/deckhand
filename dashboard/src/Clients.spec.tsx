// Settings › MCP clients against a fake api/mcp/clients: the list, its empty state, and Revoke.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Clients } from "./Clients";
import { mockApi } from "./testUtils";
import type { McpClient } from "./types";

const NOW = 1_700_000_000_000;
const client = (id: string, name: string, extra: Partial<McpClient> = {}): McpClient => ({
  id,
  name,
  client: `c-${id}`,
  redirect: "http://127.0.0.1:33418/callback",
  scopes: ["deckhand:read", "deckhand:work"],
  created: NOW - 3 * 3600_000,
  used: NOW - 120_000,
  ...extra,
});

test("lists the clients signed in as you, and Revoke ends one", async () => {
  let clients = [client("a", "Claude Code"), client("b", "Codex", { used: null })];
  const api = mockApi({
    "api/mcp/clients": () => ({ clients }),
    "POST api/mcp/clients/a/revoke": () => {
      clients = clients.filter((c) => c.id !== "a");
      return { revoked: true };
    },
  });
  render(<Clients now={() => NOW} />);
  expect(await screen.findByText("Claude Code")).toBeTruthy();
  expect(screen.getByText(/Connected 3 h ago · last used 2 min ago · Read, Work/)).toBeTruthy();
  expect(screen.getByText("Codex")).toBeTruthy();
  expect(screen.getAllByText("http://127.0.0.1:33418/callback")).toHaveLength(2);
  expect(screen.getByText(`${location.origin}/mcp`)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Revoke Claude Code" }));
  await waitFor(() => expect(screen.queryByText("Claude Code")).toBeNull());
  expect(api.posted.map((p) => p.url)).toEqual(["api/mcp/clients/a/revoke"]);
  expect(screen.getByText("Codex")).toBeTruthy();
});

test("none signed in: says so", async () => {
  mockApi({ "api/mcp/clients": () => ({ clients: [] }) });
  render(<Clients now={() => NOW} />);
  expect(await screen.findByText("No MCP client is signed in as you.")).toBeTruthy();
});

test("a refused revoke shows why, and the client stays", async () => {
  mockApi({
    "api/mcp/clients": () => ({ clients: [client("a", "Claude Code")] }),
    "POST api/mcp/clients/a/revoke": () =>
      Response.json({ error: "Not from this dashboard." }, { status: 403 }),
  });
  render(<Clients now={() => NOW} />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke Claude Code" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Not from this dashboard.",
  );
  expect(screen.getByText("Claude Code")).toBeTruthy();
});
