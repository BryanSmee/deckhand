// The S3 client (lib/s3.mjs): its signer against AWS's published SigV4 examples, then every call
// against a fake S3 server (helpers.mjs fakeS3) that checks each request's signature.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  canonicalRequest,
  checkKey,
  EMPTY_SHA256,
  s3Client,
  S3Error,
  signer,
  uriEncode,
} from "../lib/s3.mjs";
import { fakeS3 } from "./helpers.mjs";

// The generic suite's key pair (aws-sig-v4-test-suite), service `service`.
const SUITE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  service: "service",
};
const SUITE_HEADERS = { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" };
const suiteAuth = (signature) =>
  `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`;

test("s3: the signer matches the SigV4 test suite (vanilla, query order, POST, UTF-8 and space paths)", () => {
  const sign = signer(SUITE);
  const request = { method: "GET", path: "/", headers: SUITE_HEADERS, payloadHash: EMPTY_SHA256 };
  assert.equal(
    sign(request),
    suiteAuth("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"),
  );
  assert.equal(
    sign({
      ...request,
      query: [
        ["Param2", "value2"],
        ["Param1", "value1"],
      ],
    }),
    suiteAuth("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"),
  );
  assert.equal(
    sign({ ...request, method: "POST" }),
    suiteAuth("5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"),
  );
  // Paths that need encoding, as the client encodes keys: part by part, `/` kept.
  const path = (raw) => raw.split("/").map(uriEncode).join("/");
  assert.equal(
    sign({ ...request, path: path("/ሴ") }),
    suiteAuth("8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85"),
  );
  assert.equal(
    sign({ ...request, path: path("/example space/") }),
    suiteAuth("652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741"),
  );
});

test("s3: the signer matches S3's own examples (ranged GET, PUT, query strings)", () => {
  // "Examples: Signature Calculations in AWS Signature Version 4", Amazon S3's API reference.
  const sign = signer({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  const headers = {
    host: "examplebucket.s3.amazonaws.com",
    "x-amz-date": "20130524T000000Z",
    "x-amz-content-sha256": EMPTY_SHA256,
  };
  const signature = (auth) => /Signature=([0-9a-f]+)$/.exec(auth)[1];
  const get = {
    method: "GET",
    path: "/test.txt",
    headers: { ...headers, range: "bytes=0-9" },
    payloadHash: EMPTY_SHA256,
  };
  assert.equal(
    sign(get),
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  const payloadHash = createHash("sha256").update("Welcome to Amazon S3.").digest("hex");
  const put = {
    method: "PUT",
    path: `/${uriEncode("test$file.text")}`,
    headers: {
      ...headers,
      "x-amz-content-sha256": payloadHash,
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash,
  };
  assert.equal(
    signature(sign(put)),
    "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
  const list = { method: "GET", path: "/", headers, payloadHash: EMPTY_SHA256 };
  assert.equal(
    signature(sign({ ...list, query: [["lifecycle", ""]] })),
    "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  );
  assert.equal(
    signature(
      sign({
        ...list,
        query: [
          ["max-keys", "2"],
          ["prefix", "J"],
        ],
      }),
    ),
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

test("s3: the canonical request encodes as RFC 3986 and trims header values", () => {
  assert.equal(uriEncode("a b!'()*~._-/é"), "a%20b%21%27%28%29%2A~._-%2F%C3%A9");
  const canonical = canonicalRequest({
    method: "GET",
    path: "/k",
    query: [
      ["b", "1"],
      ["a", "x y"],
    ],
    headers: { "x-amz-date": "20150830T123600Z", host: "  h   ost  " },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(
    canonical,
    `GET\n/k\na=x%20y&b=1\nhost:h ost\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
  );
  assert.throws(() => signer({ accessKeyId: "a", secretAccessKey: "" }), /no secret key/);
});

// A client of `s3` (a fakeS3), closed after the test, with short waits.
function clientOf(t, s3, options = {}) {
  const client = s3Client({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    region: s3.region,
    delayMs: 5,
    timeoutMs: 5000,
    ...options,
  });
  t.after(() => client.close());
  return client;
}

// The messages of the errors `calls` throw, each of which must be an S3Error.
async function errorsOf(...calls) {
  const messages = [];
  for (const call of calls) {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof S3Error, error.stack);
      messages.push(error.message);
      return true;
    });
  }
  return messages;
}

test("s3: put, get, head and delete, against a server checking every signature", async (t) => {
  const s3 = await fakeS3(t, { region: "garage" });
  const client = clientOf(t, s3);
  const key = "logs/run 1/é$+=&?#%.log";
  assert.equal(await client.get(key), null);
  assert.equal(await client.head(key), null);
  await client.put(key, "hello, world");
  assert.deepEqual(s3.objects.get(key), Buffer.from("hello, world"));
  assert.equal(await client.head(key), 12);
  assert.deepEqual(await client.get(key), Buffer.from("hello, world"));
  await client.put("empty", Buffer.alloc(0));
  assert.equal(await client.head("empty"), 0);
  assert.deepEqual(await client.get("empty"), Buffer.alloc(0));
  await client.delete(key);
  assert.equal(s3.objects.has(key), false);
  // A 404 is done too.
  await client.delete(key);
  assert.equal(await client.get(key), null);
});

test("s3: a wrong key or region is refused, and not tried again", async (t) => {
  const s3 = await fakeS3(t);
  const secret = "a-wrong-secret-key-but-long-enough";
  const wrong = clientOf(t, s3, { secretAccessKey: secret });
  const [message] = await errorsOf(() => wrong.put("k", "x"));
  assert.equal(message, "S3 put k: 403 SignatureDoesNotMatch");
  assert.equal(s3.requests.length, 1);
  const elsewhere = clientOf(t, s3, { region: "eu-west-3" });
  await assert.rejects(elsewhere.get("k"), /403 InvalidAccessKeyId/);
  assert.equal(s3.requests.length, 2);
  assert.equal(s3.objects.size, 0);
});

test("s3: a ranged GET returns those bytes alone, what there is past the end", async (t) => {
  const s3 = await fakeS3(t);
  const client = clientOf(t, s3);
  await client.put("blob", "0123456789");
  assert.equal(String(await client.get("blob", { offset: 2, length: 3 })), "234");
  assert.equal(s3.requests.at(-1).headers.range, "bytes=2-4");
  assert.equal(String(await client.get("blob", { offset: 7 })), "789");
  assert.equal(s3.requests.at(-1).headers.range, "bytes=7-");
  assert.equal(String(await client.get("blob", { length: 2 })), "01");
  assert.equal(String(await client.get("blob", { offset: 8, length: 100 })), "89");
  assert.deepEqual(await client.get("blob", { offset: 10 }), Buffer.alloc(0));
  assert.deepEqual(await client.get("blob", { offset: 50, length: 5 }), Buffer.alloc(0));
  assert.deepEqual(await client.get("blob", { offset: 3, length: 0 }), Buffer.alloc(0));
  assert.equal(await client.get("missing", { offset: 3, length: 0 }), null);
  assert.equal(await client.get("missing", { offset: 3 }), null);
  await assert.rejects(client.get("blob", { offset: -1 }), /not an offset/);
  await assert.rejects(client.get("blob", { length: 1.5 }), /not a length/);
});

test("s3: a server that ignores the range sends it all: the part asked for comes back", async (t) => {
  const s3 = await fakeS3(t, { ignoreRange: true });
  const client = clientOf(t, s3);
  await client.put("blob", "0123456789");
  assert.equal(String(await client.get("blob", { offset: 2, length: 3 })), "234");
  assert.equal(String(await client.get("blob", { offset: 8 })), "89");
  assert.deepEqual(await client.get("blob", { offset: 20 }), Buffer.alloc(0));
});

test("s3: a 5xx, SlowDown or a dropped connection is tried again, then succeeds", async (t) => {
  const s3 = await fakeS3(t);
  const waits = [];
  const client = clientOf(t, s3, {
    retries: 3,
    delayMs: 10,
    sleep: (ms) => (waits.push(ms), new Promise((resolve) => setTimeout(resolve, 1))),
  });
  s3.fail({ status: 500, code: "InternalError" }, { status: 503, code: "SlowDown" }, "reset");
  await client.put("k", "v");
  assert.deepEqual(s3.objects.get("k"), Buffer.from("v"));
  assert.equal(s3.requests.length, 4);
  // A growing wait, with jitter: half to all of 10, 20, 40 ms.
  assert.equal(waits.length, 3);
  waits.forEach((ms, i) => assert.ok(ms >= 5 * 2 ** i && ms <= 10 * 2 ** i, `${ms}`));

  // Past `retries`, the last failure.
  s3.fail(...Array(4).fill({ status: 503, code: "SlowDown" }));
  await assert.rejects(client.get("k"), (error) => {
    assert.equal(error.message, "S3 get k: 503 SlowDown");
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(s3.requests.length, 8);
});

test("s3: a 4xx isn't tried again", async (t) => {
  const s3 = await fakeS3(t);
  const client = clientOf(t, s3);
  s3.fail({ status: 403, code: "AccessDenied" }, { status: 400, code: "InvalidRequest" });
  await assert.rejects(client.put("k", "v"), /^S3Error: S3 put k: 403 AccessDenied$/m);
  await assert.rejects(client.delete("k"), /S3 delete k: 400 InvalidRequest/);
  // HEAD has no body: its status alone.
  s3.fail({ status: 403, code: "AccessDenied" });
  await assert.rejects(client.head("k"), (error) => error.message === "S3 head k: 403");
  assert.equal(s3.requests.length, 3);
});

test("s3: a call that takes too long fails at its deadline", async (t) => {
  const s3 = await fakeS3(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-02T00:00:00Z") });
  const client = clientOf(t, s3, { timeoutMs: 200 });
  s3.fail("hang");
  let settled = false;
  const call = client.get("k").finally(() => (settled = true));
  await s3.arrived(1);
  t.mock.timers.tick(199);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(call, /^S3Error: S3 get k: timed out after 200 ms$/m);
  assert.equal(s3.requests.length, 1);
});

test("s3: a server failing until the deadline: no retry starts past it", async (t) => {
  const s3 = await fakeS3(t);
  // The waits move the clock on, not time.
  let clock = Date.parse("2026-11-02T00:00:00Z");
  const waits = [];
  const client = clientOf(t, s3, {
    timeoutMs: 200,
    retries: 100,
    delayMs: 50,
    now: () => new Date(clock),
    sleep: async (ms) => (waits.push(ms), (clock += ms)),
  });
  s3.fail(...Array(100).fill({ status: 500, code: "InternalError" }));
  await assert.rejects(client.put("k", "v"), /^S3Error: S3 put k: 500 InternalError$/m);
  assert.equal(s3.requests.length, waits.length + 1);
  assert.ok(waits.length >= 2 && waits.length <= 3, `${waits}`);
  assert.ok(clock < Date.parse("2026-11-02T00:00:00.200Z"));
});

test("s3: an error that isn't the network's is thrown as it is, not tried again", async (t) => {
  const s3 = await fakeS3(t);
  const client = clientOf(t, s3, { now: () => new Date(NaN) });
  await assert.rejects(client.put("k", "v"), RangeError);
  assert.equal(s3.requests.length, 0);
});

test("s3: the calls work apart from the client, as callbacks", async (t) => {
  const s3 = await fakeS3(t);
  const { put, get, head, delete: remove } = clientOf(t, s3);
  await put("k", "abc");
  assert.deepEqual(await get("k", { length: 0 }), Buffer.alloc(0));
  assert.equal(await get("missing", { length: 0 }), null);
  assert.equal(await head("k"), 3);
  await remove("k");
  assert.equal(await head("k"), null);
});

test("s3: a server sending more than the range, or no size, isn't believed", async (t) => {
  const s3 = await fakeS3(t, { overRange: true, headWithoutSize: true });
  const client = clientOf(t, s3);
  await client.put("blob", "0123456789");
  assert.equal(String(await client.get("blob", { offset: 2, length: 3 })), "234");
  await assert.rejects(client.head("blob"), /^S3Error: S3 head blob: no size$/m);
});

test("s3: a key that would climb out of its prefix is refused before any request", async (t) => {
  const s3 = await fakeS3(t);
  const client = clientOf(t, s3, { prefix: "/deckhand/blobs/" });
  for (const key of [
    "",
    "../x",
    "a/../../x",
    "/abs",
    "a//b",
    "a/",
    ".",
    "a/./b",
    "a\\..\\b",
    "a\nb",
    "x".repeat(1025),
    null,
  ]) {
    assert.throws(() => checkKey(key), TypeError, JSON.stringify(key));
    await assert.rejects(client.put(key, "v"), TypeError);
    await assert.rejects(client.get(key), TypeError);
  }
  assert.equal(s3.requests.length, 0);
  assert.equal(checkKey("a/..b/c.."), "a/..b/c..");
  await client.put("runs/1.log", "v");
  assert.deepEqual([...s3.objects.keys()], ["deckhand/blobs/runs/1.log"]);
  assert.equal(String(await client.get("runs/1.log")), "v");
  assert.throws(() => clientOf(t, s3, { prefix: "a/../b" }), TypeError);
  // S3's limit holds the prefix too: a key under it alone, past it once joined.
  const sent = s3.requests.length;
  await assert.rejects(client.put("x".repeat(1010), "v"), /too long/);
  assert.equal(s3.requests.length, sent);
  await client.put("x".repeat(1024 - "deckhand/blobs/".length), "v");
  assert.equal(s3.requests.length, sent + 1);
});

test("s3: an endpoint's base path goes before the bucket", async (t) => {
  const s3 = await fakeS3(t, { basePath: "/s3" });
  const client = clientOf(t, s3, { endpoint: `${s3.endpoint}/s3/` });
  await client.put("a/k", "v");
  assert.equal(String(await client.get("a/k")), "v");
  assert.deepEqual([...s3.objects.keys()], ["a/k"]);
});

test("s3: DNS or TLS failing is no network blip: named, not tried again", async (t) => {
  const s3 = await fakeS3(t);
  const lookups = [];
  const failing = (code) => (host, options, callback) => {
    lookups.push(code);
    callback(Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code }));
  };
  // A name, not an address: lookup() is asked for it.
  const endpoint = s3.endpoint.replace("127.0.0.1", "s3.test");
  const missing = clientOf(t, s3, { endpoint, lookup: failing("ENOTFOUND"), retries: 3 });
  await assert.rejects(missing.get("k"), /^S3Error: S3 get k: ENOTFOUND$/m);
  assert.deepEqual(lookups, ["ENOTFOUND"]);
  // A DNS server that didn't answer this time: tried again.
  const flaky = clientOf(t, s3, { endpoint, lookup: failing("EAI_AGAIN"), retries: 2 });
  await assert.rejects(flaky.head("k"), /^S3Error: S3 head k: EAI_AGAIN$/m);
  assert.equal(lookups.length, 4);
  // A plain-HTTP server behind an https:// endpoint: TLS fails, with its code.
  const tls = clientOf(t, s3, { endpoint: s3.endpoint.replace("http:", "https:"), retries: 3 });
  await assert.rejects(tls.get("k"), (error) => {
    assert.ok(error instanceof S3Error);
    assert.match(error.message, /^S3 get k: [A-Z_]+$/);
    return true;
  });
  assert.equal(s3.requests.length, 0);
});

test("s3: virtual-hosted style puts the bucket in the host", async (t) => {
  const s3 = await fakeS3(t);
  const client = clientOf(t, s3, {
    pathStyle: false,
    endpoint: s3.endpoint.replace("127.0.0.1", "s3.test"),
    // `deckhand.s3.test` is the fake's.
    lookup: (host, options, callback) =>
      options.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4),
  });
  await client.put("k", "v");
  assert.equal(s3.requests[0].headers.host, `deckhand.s3.test:${new URL(s3.endpoint).port}`);
  assert.deepEqual(s3.objects.get("k"), Buffer.from("v"));
  assert.equal(String(await client.get("k")), "v");
});

test("s3: no error, nor the client, holds the secret key or a signature", async (t) => {
  const s3 = await fakeS3(t);
  const secret = "the-secret-that-must-not-leak-0123456789";
  const client = clientOf(t, s3, { secretAccessKey: secret, timeoutMs: 300, retries: 1 });
  const messages = await errorsOf(
    () => client.put("k", "v"), // SignatureDoesNotMatch, whose body quotes the signature
    () => client.get("k", { offset: 1 }),
    () => client.head("k"),
    () => client.delete("k"),
  );
  assert.match(messages[0], /SignatureDoesNotMatch$/);
  s3.fail("hang");
  messages.push(...(await errorsOf(() => client.get("k"))));
  assert.match(messages.at(-1), /timed out/);
  s3.fail("reset", "reset");
  messages.push(...(await errorsOf(() => client.put("k", "v"))));
  assert.match(messages.at(-1), /^S3 put k: ECONNRESET$/);
  const signatures = s3.requests.map(
    (r) => /Signature=([0-9a-f]{64})/.exec(r.headers.authorization)[1],
  );
  for (const text of [...messages, inspect(client, { showHidden: true, depth: 9 })]) {
    assert.ok(!text.includes(secret), text);
    assert.ok(!/Signature=|Credential=/.test(text), text);
    for (const signature of signatures) assert.ok(!text.includes(signature), text);
  }
  assert.throws(
    () =>
      s3Client({
        endpoint: "https://user:pass@s3.test",
        bucket: "b",
        accessKeyId: "a",
        secretAccessKey: "s",
      }),
    /nothing more/,
  );
  assert.throws(
    () =>
      s3Client({ endpoint: "ftp://s3.test", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }),
    /not an http/,
  );
  assert.throws(
    () =>
      s3Client({
        endpoint: "https://s3.test",
        bucket: "a/b",
        accessKeyId: "a",
        secretAccessKey: "s",
      }),
    /not a bucket/,
  );
});
