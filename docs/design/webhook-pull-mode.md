# Webhook pull mode: the spike

Pull mode (#1032) lets Deckhand run without a public address: edge reads the App's deliveries
through the API (`GET /app/hook/deliveries`) instead of receiving them. It only works if GitHub
keeps recording the deliveries of an App whose webhook URL never answers, and if `/setup` can
create such an App. This page is the record of the spike that checked both (#1030, 2026-11-09 to
2026-11-11), and what pull mode takes from it. The API answers seen are in the issue's comments.

## How it was checked

Three throwaway Apps, read-only (`issues`, `actions`, `metadata`), installed on one private
repository whose scheduled workflow commented on an issue: one with its webhook at
`https://deckhand-pull.invalid/webhook`, one at `https://192.0.2.1/webhook` (TEST-NET-1), one
inactive. 40 hours of events, then a burst of 150 comments in 15 minutes.

## Findings

- **The manifest accepts an unreachable URL.** `.invalid` and a TEST-NET address are accepted.
  `localhost` and `127.0.0.1` are refused (`isn't reachable over the public Internet`), and so is
  a manifest without a webhook URL (`Hook url cannot be blank`). A `localhost` callback URL beside
  a public one is accepted and kept, so the dashboard's sign-in through `localhost` works.
- **GitHub doesn't disable the webhook.** After about 180 failed deliveries per App (149 in 15
  minutes), every event was still recorded (`502 failed to connect to host`), none throttled
  (`throttled_at: null`), the webhook's config unchanged. Not checked: the App's settings pages
  and GitHub's emails.
- **Each delivery's payload can be read back.** `GET /app/hook/deliveries/{id}` answers with
  `request.payload` (the whole event) and `request.headers` (`X-Github-Event`,
  `X-Github-Delivery`…). Events caused by a workflow's `GITHUB_TOKEN` are delivered to Apps too.
- **An inactive webhook records nothing** but its creation's `ping`, and
  `GET /app/hook/config` doesn't say whether the webhook is active.
- **Delay:** an event is in the list 1.4 to 7 s after it happened (p95 under 5.1 s).
- **Delivery IDs are past 2^53** (about 3.85e18): `JSON.parse` rounds them to another
  delivery's, which GitHub answers 404. Fixed for the redeliveries in #1079
  (`parseDeliveries()` in `listener/redeliveries.mjs`).
- One comment of the burst never had an event, for either App: GitHub didn't generate it. A
  webhook that answers would have missed it too; Sync and the periodic reads catch such a gap in
  both modes.

## Decision: go

Pull mode goes ahead (#1032). What it should do:

- **Webhook URL:** `/setup`'s "no public address" choice creates the App with
  `hook_attributes: { url: "https://deckhand.invalid/webhook", active: true }`. `.invalid`
  (RFC 6761) never resolves, so no payload of a private repository can reach a host someone else
  holds, as a real domain that lapses or changes owner could; and it fails at once, where a
  TEST-NET address costs GitHub a 1 to 2 s attempt. Active, since an inactive webhook records
  nothing.
- **IDs:** read the list and each delivery with `parseDeliveries()`, never `res.json()`.
- **Payload:** take `request.payload` as the event, `X-Github-Event` and `X-Github-Delivery` (the
  GUID edge already keys its deliveries on) from `request.headers`. `X-Hub-Signature-256` signs
  the bytes GitHub sent, not this re-serialized object: there is nothing to check it against,
  and nothing to check, as the payload comes over the App's own authenticated channel.
- **Poll every 10 to 15 s:** the list's own delay is under 7 s.
- **A silent off switch:** an operator who unticks "Active" leaves pull mode reading an empty
  list without an error. Show when the last delivery was seen, or warn when an App with
  installations has had none for a long time.
- **Redeliveries off:** every delivery fails in pull mode, so `listener/redeliveries.mjs` would
  ask GitHub to redeliver to `.invalid` any delivery it scans before the poller takes it.
