// An S3 client, the few calls blob storage makes (#604), over node:http or node:https: Signature
// V4 with node:crypto, no package (#605), as resp.mjs is for Redis. PUT, ranged GET, HEAD and
// DELETE of one object, path-style URLs by default (what self-hosted servers expect).
//
// The secret key stays in signer()'s closure: no error, log line or object the client returns
// holds it, nor a signature (S3's own error bodies quote the signature provided: only their
// <Code> is kept).
import { createHash, createHmac } from "node:crypto";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

export class S3Error extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

export const EMPTY_SHA256 = sha256("");

// RFC 3986's encoding, as SigV4 wants it: everything but the unreserved characters, which
// encodeURIComponent() leaves `!'()*` out of.
export function uriEncode(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// `20150830T123600Z`, from a Date.
export const amzDate = (date) => date.toISOString().replace(/[-:]|\.\d{3}/g, "");

// The canonical request (SigV4's first step). `path`: as sent, already encoded (S3 signs it as
// it is, without normalizing it). `query`: [name, value] pairs, decoded. `headers`: lowercase
// name → value, every one of them signed.
export function canonicalRequest({ method, path, query = [], headers, payloadHash }) {
  const names = Object.keys(headers).sort();
  const canonicalQuery = query
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  return [method, path, canonicalQuery, canonicalHeaders, names.join(";"), payloadHash].join("\n");
}

// A signer for one key pair: sign(request) → the Authorization header's value, for a request
// whose headers hold `x-amz-date`. The secret goes nowhere else, and the signing key derived
// from it is kept for the day it was derived for.
export function signer({ accessKeyId, secretAccessKey, region = "us-east-1", service = "s3" }) {
  if (!accessKeyId || !secretAccessKey) throw new TypeError("S3: no access key or no secret key");
  let day = null;
  let signingKey = null;
  return function sign(request) {
    const date = request.headers["x-amz-date"];
    if (!/^\d{8}T\d{6}Z$/.test(date ?? "")) throw new TypeError("S3: no x-amz-date to sign");
    if (date.slice(0, 8) !== day) {
      day = date.slice(0, 8);
      const kDate = hmac(`AWS4${secretAccessKey}`, day);
      signingKey = hmac(hmac(hmac(kDate, region), service), "aws4_request");
    }
    const scope = `${day}/${region}/${service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest(request))].join(
      "\n",
    );
    const signature = hmac(signingKey, stringToSign).toString("hex");
    const signed = Object.keys(request.headers).sort().join(";");
    return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  };
}

// A key the client will use: relative, `/`-separated, with no empty, `.` or `..` part, and no
// control character or backslash, so that once joined to the prefix it stays under it (on S3
// and on a server that maps keys to files alike). S3's limit is 1024 bytes.
export function checkKey(key) {
  if (typeof key !== "string" || !key) throw new TypeError("S3: a key is a non-empty string");
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f\\]/.test(key) || Buffer.byteLength(key) > 1024;
  if (bad || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`S3: not a key: ${JSON.stringify(key.slice(0, 200))}`);
  }
  return key;
}

// S3's error code, from an XML error body: only a word, never the rest (which may quote the
// signature provided, or the string it was computed from).
function errorCode(body) {
  const code = /<Code>([^<]{1,64})<\/Code>/.exec(body.toString("utf8", 0, 4096))?.[1];
  return code && /^[A-Za-z0-9.]+$/.test(code) ? code : null;
}

const sleeping = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A client of one bucket: put(), get(), head(), delete(), close().
//   endpoint     `https://host[:port][/path]`
//   region       `us-east-1` by default (Garage's is `garage`)
//   prefix       where every key goes, under the bucket (`deckhand`: `deckhand/<key>`)
//   pathStyle    `host/bucket/key` (default), or `bucket.host/key`
//   timeoutMs    how long a call may take, its retries included
//   retries      how many times a call is tried again, after a 5xx (`503 SlowDown` too) or a
//                connection error; never after a 4xx. `delayMs`: the first wait, doubling.
//   lookup       node:dns's lookup() by default (the tests resolve a bucket's host to the fake)
export function s3Client({
  endpoint,
  bucket,
  accessKeyId,
  secretAccessKey,
  region = "us-east-1",
  prefix = "",
  pathStyle = true,
  timeoutMs = 30_000,
  retries = 3,
  delayMs = 200,
  now = () => new Date(),
  sleep = sleeping,
  lookup,
}) {
  const base = new URL(endpoint);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError(`S3: not an http(s) endpoint: ${base.protocol}`);
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError("S3: an endpoint is a scheme, a host and a path, nothing more");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(bucket ?? "")) {
    throw new TypeError(`S3: not a bucket name: ${JSON.stringify(bucket)}`);
  }
  prefix = prefix.replace(/^\/+|\/+$/g, "");
  if (prefix) checkKey(prefix);
  const sign = signer({ accessKeyId, secretAccessKey, region });
  const https = base.protocol === "https:";
  const request = https ? httpsRequest : httpRequest;
  const agent = new (https ? HttpsAgent : HttpAgent)({ keepAlive: true });
  const basePath = base.pathname.replace(/\/+$/, "");
  const host = pathStyle ? base.host : `${bucket}.${base.host}`;

  // The URL of an object: its key encoded part by part, `/` kept.
  function urlOf(key) {
    const full = prefix ? `${prefix}/${checkKey(key)}` : checkKey(key);
    const encoded = full.split("/").map(uriEncode).join("/");
    const path = pathStyle ? `${basePath}/${bucket}/${encoded}` : `${basePath}/${encoded}`;
    return { path, url: `${base.protocol}//${host}${path}` };
  }

  // One request, signed, until `deadline`: { status, headers, body }. A connection error or the
  // deadline rejects.
  function once({ method, path, url, headers, body, deadline }) {
    const payload = body ?? Buffer.alloc(0);
    const signed = {
      host,
      "x-amz-content-sha256": sha256(payload),
      "x-amz-date": amzDate(now()),
      ...headers,
    };
    const authorization = sign({
      method,
      path,
      headers: signed,
      payloadHash: signed["x-amz-content-sha256"],
    });
    const sent = { ...signed, authorization };
    if (body) sent["content-length"] = payload.length;
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        { method, headers: sent, agent, ...(lookup && { lookup }) },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
          res.on("error", reject);
        },
      );
      // Past the deadline, the call fails with that, whatever the socket says once destroyed.
      const timer = setTimeout(
        () => {
          reject(new S3Error(`timed out after ${timeoutMs} ms`));
          req.destroy();
        },
        Math.max(0, deadline - Date.now()),
      );
      const settle = () => clearTimeout(timer);
      req.on("close", settle);
      req.on("error", (error) => (settle(), reject(error)));
      req.end(body ? payload : undefined);
    });
  }

  // A call, tried again on a 5xx or a connection error until `retries` or the deadline: its
  // response when `accept(status)` says so, else an S3Error naming the call, the key and S3's
  // code alone.
  async function call(name, method, key, { headers = {}, body, accept }) {
    const where = `S3 ${name} ${key}`;
    const target = urlOf(key);
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      let failure;
      try {
        const response = await once({ method, ...target, headers, body, deadline });
        if (accept(response.status)) return response;
        const code = errorCode(response.body);
        failure = new S3Error(`${where}: ${response.status}${code ? ` ${code}` : ""}`, {
          status: response.status,
          code,
          retryable: response.status >= 500,
        });
      } catch (error) {
        // A connection error: its code (ECONNRESET), or a timeout's message. Never a header.
        const timedOut = error instanceof S3Error;
        failure = new S3Error(
          `${where}: ${timedOut ? error.message : (error.code ?? error.message)}`,
          {
            code: timedOut ? null : (error.code ?? null),
            retryable: !timedOut,
          },
        );
      }
      const wait = delayMs * 2 ** attempt * (0.5 + Math.random() / 2);
      if (!failure.retryable || attempt >= retries || Date.now() + wait >= deadline) throw failure;
      await sleep(wait);
    }
  }

  return {
    async put(key, data) {
      const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await call("put", "PUT", key, { body, accept: (s) => s === 200 });
    },

    // Its bytes from `offset` (`length` of them at most): what there is past the end, nothing
    // from past it. Null: no such object.
    async get(key, { offset = 0, length } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("S3: not an offset");
      if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
        throw new TypeError("S3: not a length");
      }
      if (length === 0) return (await this.head(key)) === null ? null : Buffer.alloc(0);
      const ranged = offset > 0 || length !== undefined;
      const headers = ranged
        ? { range: `bytes=${offset}-${length === undefined ? "" : offset + length - 1}` }
        : {};
      const {
        status,
        headers: got,
        body,
      } = await call("get", "GET", key, {
        headers,
        accept: (s) => s === 200 || s === 206 || s === 404 || (ranged && s === 416),
      });
      if (status === 404) return null;
      if (status === 416) return Buffer.alloc(0);
      if (status === 200) {
        // A server that ignored the range sent it all: the part asked for, then.
        return ranged
          ? body.subarray(offset, length === undefined ? undefined : offset + length)
          : body;
      }
      const start = Number(/^bytes (\d+)-/.exec(got["content-range"] ?? "")?.[1]);
      if (start !== offset)
        throw new S3Error(`S3 get ${key}: a range from ${start}, not ${offset}`);
      return body;
    },

    // Its size in bytes, or null: no such object.
    async head(key) {
      const { status, headers } = await call("head", "HEAD", key, {
        accept: (s) => s === 200 || s === 404,
      });
      return status === 404 ? null : Number(headers["content-length"]);
    },

    // Gone, whether it was there or not.
    async delete(key) {
      await call("delete", "DELETE", key, { accept: (s) => s === 204 || s === 200 || s === 404 });
    },

    close() {
      agent.destroy();
    },
  };
}
