// The header's Sync: asks the listener to catch up with GitHub, says what it did, and reads
// the board again (fetch mocked).
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { syncMessage } from "./Sync";
import { makeState, mockApi } from "./testUtils";

let api: ReturnType<typeof mockApi>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  history.replaceState(null, "", "#/all");
  api = mockApi();
  refresh = vi.fn<() => Promise<void>>(async () => {});
});

const show = () => render(<Dashboard state={makeState()} error={null} refresh={refresh} />);

test("Sync asks the listener, says what it did, then reads the state again", async () => {
  api.answer = () => ({ redelivered: 2, pulls: 1 });
  show();
  const release = api.hold();
  fireEvent.click(screen.getByRole("button", { name: "Sync" }));
  expect(screen.getByRole("button", { name: "Syncing…" })).toHaveProperty("disabled", true);
  release();
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "Synced: 2 missed deliveries asked again, 1 pull request updated",
    ),
  );
  expect(api.posted).toEqual([{ url: "api/sync", body: undefined }]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Sync" })).toHaveProperty("disabled", false);
});

test("a refused sync says why, and reads nothing again", async () => {
  api.answer = () => Response.json({ error: "Synced a moment ago." }, { status: 429 });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Sync" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Couldn't sync (Synced a moment ago.)"),
  );
  expect(refresh).not.toHaveBeenCalled();
});

test("a sync that failed says GitHub's error", async () => {
  api.answer = () =>
    Response.json(
      {
        at: 1,
        by: "octocat",
        redelivered: 0,
        pulls: 0,
        error: "GitHub GET /app/hook/deliveries: 502",
      },
      { status: 502 },
    );
  show();
  fireEvent.click(screen.getByRole("button", { name: "Sync" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't sync (GitHub GET /app/hook/deliveries: 502)",
    ),
  );
  expect(refresh).not.toHaveBeenCalled();
});

test("nothing to catch up, or one of each", () => {
  expect(syncMessage({ redelivered: 0, pulls: 0 })).toBe("Up to date with GitHub");
  expect(syncMessage({ redelivered: 1, pulls: 0 })).toBe("Synced: 1 missed delivery asked again");
  expect(syncMessage({ redelivered: 0, pulls: 3 })).toBe("Synced: 3 pull requests updated");
});

test("no Sync before the first state", () => {
  render(<Dashboard state={null} error={null} refresh={refresh} />);
  expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
});
