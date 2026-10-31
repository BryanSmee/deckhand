// redact(): whole secrets, parts of them long enough to be one (a value cut off in an error
// message), and GitHub tokens of any origin, out of what a run publishes (#242).
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../listener/secrets.mjs";
import { signToken, TOKEN_VERSION } from "../lib/tokens.mjs";
import { testKey } from "./helpers.mjs";

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
  // Too short.
  assert.equal(redact("ghs_short", []), "ghs_short");
});

test("a run token is redacted by its shape: the broker service renews them, the listener lists the first alone", () => {
  const token = signToken(
    { ver: TOKEN_VERSION, jti: "run-a" },
    { ...testKey(), audience: "deckhand:broker", ttlMs: 60_000 },
  );
  assert.equal(redact(`$ deckhand-token\n${token}\n`, []), "$ deckhand-token\n[redacted]\n");
  // Another issuer's JWT (another header) stays: a reply may quote one.
  const other = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
  assert.equal(redact(other, []), other);
});

test("a GitHub token on a line of its own in a raw stream-json line is redacted too", () => {
  // The line as runs.mjs redacts it before the log: a newline is the two characters `\n`.
  const ghs = "ghs_" + "a1B2c3D4e5".repeat(4);
  const line = JSON.stringify({ content: `$ gh auth token\n${ghs}\n`, tab: `a\t${ghs}` });
  assert.equal(
    redact(line, []),
    JSON.stringify({ content: "$ gh auth token\n[redacted]\n", tab: "a\t[redacted]" }),
  );
});

test("a JWT secret's header alone isn't redacted: other tokens of its issuer share it", () => {
  const header = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9";
  const jwt = `${header}.eyJzdWIiOiJvcGVyYXRvciIsImV4cCI6MTc5MH0.c2lnbmF0dXJlLXZhbHVlLTAxMjM0NTY3ODk`;
  const other = `${header}.eyJpc3MiOiJzb21lb25lLWVsc2UifQ.b3RoZXI`;
  assert.equal(redact(`example: ${other}`, [jwt]), `example: ${other}`);
  assert.equal(redact(`leak: ${jwt}!`, [jwt]), "leak: [redacted]!");
  // Its payload, cut off.
  assert.equal(redact(`…${jwt.slice(40, 70)}`, [jwt]), "…[redacted]");
});

// What redact() must give, the slow way: every character of `text` within a common part of it
// and a secret MIN_LENGTH (16) long or more is redacted.
function reference(text, secrets) {
  const covered = new Array(text.length).fill(false);
  for (const secret of secrets) {
    for (let s = 0; s < text.length; s++) {
      for (let i = 0; i < secret.length; i++) {
        let k = 0;
        while (s + k < text.length && i + k < secret.length && text[s + k] === secret[i + k]) k++;
        if (k >= 16) covered.fill(true, s, s + k);
      }
    }
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!covered[i]) out += text[i];
    else if (i === 0 || !covered[i - 1]) out += "[redacted]";
  }
  return out;
}

test("redact() finds every part 16 characters long or more, wherever it starts", () => {
  // A small alphabet, so that secrets and texts share parts of every length.
  let seed = 42;
  const random = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const word = (n) => Array.from({ length: n }, () => "ab"[random(2)]).join("");
  for (let round = 0; round < 300; round++) {
    const secrets = [word(16 + random(30)), word(16 + random(30))];
    // Pieces of the secrets, of any length and at any offset, between random characters.
    let text = "";
    while (text.length < 120) {
      const secret = secrets[random(2)];
      const from = random(secret.length);
      text += word(random(10)).toUpperCase() + secret.slice(from, from + 10 + random(30));
    }
    assert.equal(
      redact(text, secrets),
      reference(text, secrets),
      JSON.stringify({ text, secrets }),
    );
  }
});
