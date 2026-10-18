// redact(): whole secrets, parts of them long enough to be one (a value cut off in an error
// message), and GitHub tokens of any origin, out of what a run publishes (#242).
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../listener/secrets.mjs";

const access = "ya29.a0AfB_byC-0123456789abcdefghijklmnopqrstuvwxyz";

test("a part of a secret 16 characters long or more is redacted, shorter ones aren't", () => {
  // The first 300 characters of a token file: its access token, then the start of the next.
  const refresh = "1//0gLongRefreshTokenValue-abcdefghijklmnop";
  assert.equal(
    redact(`{"access_token":"${access}","refresh_token":"${refresh.slice(0, 20)}`, [
      access,
      refresh,
    ]),
    '{"access_token":"[redacted]","refresh_token":"[redacted]',
  );
  // Its end, or a middle part.
  assert.equal(
    redact(`…${access.slice(-18)} and ${access.slice(5, 25)}.`, [access]),
    "…[redacted] and [redacted].",
  );
  // 15 characters: no credential, and could be ordinary text.
  assert.equal(redact(`x ${access.slice(0, 15)} y`, [access]), `x ${access.slice(0, 15)} y`);
});

test("overlapping or adjacent secrets make one redaction", () => {
  const a = "A".repeat(10) + "0123456789abcdef";
  const b = "0123456789abcdef" + "B".repeat(10);
  assert.equal(
    redact(`<${"A".repeat(10)}0123456789abcdef${"B".repeat(10)}>`, [a, b]),
    "<[redacted]>",
  );
  assert.equal(redact(`${access}${access}`, [access]), "[redacted]");
});

test("GitHub tokens are redacted by their shape, whoever issued them", () => {
  const ghs = "ghs_" + "a1B2c3D4e5".repeat(4);
  const pat = "github_pat_11ABCDEFG0" + "x".repeat(12) + "_" + "Y".repeat(59);
  assert.equal(
    redact(`token: ${ghs}\nAuthorization: token ${pat}, gho_${"z".repeat(36)}`, []),
    "token: [redacted]\nAuthorization: token [redacted], [redacted]",
  );
  // Too short, or no token prefix.
  assert.equal(
    redact("ghs_short and xghs_" + "a".repeat(36), []),
    "ghs_short and xghs_" + "a".repeat(36),
  );
});
