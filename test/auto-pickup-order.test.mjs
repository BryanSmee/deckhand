import assert from "node:assert/strict";
import { test } from "node:test";
import { SEVERITIES, severityRank } from "../listener/severities.mjs";
import { issue, setup } from "./fixtures/auto-pickup.mjs";

// An issue labelled auto-pickup and `names`.
const tagged = (number, day, ...names) =>
  issue(number, day, { labels: [{ name: "auto-pickup" }, ...names.map((name) => ({ name }))] });

test("severityRank(): the most severe `severity: *` label, case-insensitively; none after low", () => {
  assert.deepEqual(SEVERITIES, ["critical", "high", "medium", "low"]);
  assert.equal(severityRank([{ name: "severity: critical" }]), 0);
  assert.equal(severityRank([{ name: "Severity: High" }]), 1);
  assert.equal(severityRank([{ name: "severity: low" }, { name: "severity: medium" }]), 2);
  assert.equal(severityRank(["severity:low"]), 3);
  assert.equal(severityRank([{ name: "auto-pickup" }]), 4);
  assert.equal(severityRank([{ name: "severity: urgent" }, { name: "high" }]), 4);
  assert.equal(severityRank(undefined), 4);
});

test("a later severity: high issue starts before an older severity: low one in another repo", async () => {
  const { pickup, p } = setup({
    repos: {
      "org/a": { issues: [tagged(1, 1, "severity: low")] },
      "org/b": { issues: [tagged(2, 9, "Severity: High")] },
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/b#2"]);
  // No GitHub call of its own: the labels come with the list, and the issue passed over isn't read.
  assert.equal(p.calls.filter((c) => c.includes("/repos/org/a/issues/1")).length, 0);
});

test("the order: by the most severe label, unlabelled after low, oldest first among equals", async () => {
  const { pickup } = setup({
    env: { MAX_PARALLEL: "8", AUTO_PICKUP_SLOTS: "7" },
    repos: {
      "org/a": {
        issues: [
          tagged(1, 1),
          tagged(2, 2, "severity: low"),
          tagged(3, 3, "severity: medium"),
          tagged(4, 4, "severity: low", "severity: critical"),
          tagged(5, 5),
          tagged(6, 6, "severity: medium"),
          tagged(7, 7, "severity: high"),
        ],
      },
    },
  });
  assert.deepEqual(await pickup.sweep(), [
    "org/a#4",
    "org/a#7",
    "org/a#3",
    "org/a#6",
    "org/a#2",
    "org/a#1",
    "org/a#5",
  ]);
});

test("a skipped critical issue doesn't hold the slot: the next one in order starts", async () => {
  const { pickup, p } = setup({
    repos: {
      "org/a": {
        issues: [
          tagged(1, 1),
          tagged(2, 2, "severity: low"),
          tagged(3, 3, "severity: critical", "needs-input"),
        ],
      },
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#2"]);
  assert.equal(p.logs[0], "Auto-pickup: org/a#3: skipped, it has open questions (needs-input)");
});
