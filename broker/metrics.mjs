// The broker's metrics (#660): the tokens it signs, renews and refuses, the runs it holds and the
// inboxes' long polls open. Declared on the service's registry (../lib/metrics.mjs), served on
// METRICS_PORT. Each copy counts what it answered: add the copies' counters up; the live runs are
// their shared store's, the same in both (take the max).

// The tokens it signs:
//   run      a run's token, at its start and at each renewal that signs a new one
//   agent    a run's agent token, at its start (the models service takes it)
//   service  a service's token for one service it calls (POST /service-tokens)
const TOKEN_KINDS = ["run", "agent", "service"];
// What a sandbox's renewal (POST /run/token) got:
//   renewed  a new token
//   again    the one signed less than a minute before (runs.mjs RENEW_MIN_MS)
//   refused  none (deckhand_tokens_refused_total says why)
const RENEWAL_RESULTS = ["renewed", "again", "refused"];
// Why a token, a run's or a service's, was refused:
//   expired         past its expiry (a run token renews up to its grace, the newest only)
//   invalid         none, not a token, another key's, another service's, a token of another kind
//   run_over        its run ended, or isn't one the broker holds
//   wrong_sandbox   a run token from another sandbox than its own
//   unknown_caller  a service token from another service's network, or asked from no service's
//   not_allowed     a service asking what it may not (an endpoint, another service's token)
const REFUSAL_REASONS = [
  "expired",
  "invalid",
  "run_over",
  "wrong_sandbox",
  "unknown_caller",
  "not_allowed",
];

// The hooks the broker's HTTP API calls when no registry is given: counting nothing.
export const NO_METRICS = {
  issued() {},
  renewal() {},
  refused() {},
  polling: () => () => {},
};

// `runs`: runs.mjs's, for the live runs at each scrape. → the hooks http.mjs calls: issued(kind,
// count), renewal(result), refused(reason), polling() → done().
export function brokerMetrics(registry, { runs }) {
  const issued = registry.counter("deckhand_tokens_issued_total", "Tokens signed, by kind.", {
    labels: ["kind"],
    values: { kind: TOKEN_KINDS },
  });
  const renewals = registry.counter(
    "deckhand_token_renewals_total",
    "Run tokens' renewals, by result: a new token, the last one again, or refused.",
    { labels: ["result"], values: { result: RENEWAL_RESULTS } },
  );
  const refused = registry.counter(
    "deckhand_tokens_refused_total",
    "Tokens refused, a run's or a service's, by why.",
    { labels: ["reason"], values: { reason: REFUSAL_REASONS } },
  );
  registry.gauge("deckhand_runs_live", "The live runs the broker holds, every copy's.", {
    collect: () => runs.live(),
  });
  const polls = registry.gauge(
    "deckhand_inbox_polls_open",
    "Sandboxes' inbox long polls (GET /run/inbox) this copy holds open.",
  );
  return {
    issued: (kind, count = 1) => issued.inc({ kind }, count),
    renewal: (result) => renewals.inc({ result }),
    // A refusal without a reason is no token's (a body too large, a path that isn't plain).
    refused: (reason) => reason && refused.inc({ reason }),
    polling() {
      polls.inc();
      let done = false;
      return () => {
        if (!done) polls.dec();
        done = true;
      };
    },
  };
}

// Every metric its server declares, and test/metrics-services.test.mjs: brokerMetrics()'s alone.
export const declareMetrics = brokerMetrics;
