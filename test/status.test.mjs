import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatus, serverInfo } from "../listener/status.mjs";

test("serverInfo: the image's version and repository, Node's version, and when it started", () => {
  const now = () => 1791990000000;
  assert.deepEqual(
    serverInfo(
      { DECKHAND_VERSION: "edge-1713fa6", DECKHAND_SOURCE: "https://github.com/acme/deckhand/" },
      now,
    ),
    {
      version: "edge-1713fa6",
      startedAt: 1791990000000,
      node: process.version,
      // Without its trailing slash: the dashboard adds /commit/<sha>.
      source: "https://github.com/acme/deckhand",
    },
  );
  // Built from source: "dev", nothing to link to.
  const dev = serverInfo({ DECKHAND_VERSION: "", DECKHAND_SOURCE: "" }, now);
  assert.deepEqual([dev.version, dev.source], ["dev", ""]);
});

test("/status says since when the listener runs, next to its version", () => {
  const ctx = {
    server: serverInfo({ DECKHAND_VERSION: "1.2.3" }, () => 1000),
    tasks: new Map(),
    runs: [],
    previews: { status: () => [] },
    running: 0,
    app: null,
  };
  const status = createStatus(ctx).status();
  assert.deepEqual([status.version, status.startedAt, status.idle], ["1.2.3", 1000, true]);
});
