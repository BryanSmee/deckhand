// Blob storage (#604, #606): where a service that keeps blobs (the runner's logs, the broker's
// files) puts those that will never change again, apart from its store. BLOB_URL names it:
//
//   s3://<bucket>[/<prefix>]?endpoint=https://…&region=…   any S3-compatible server, through
//                                                          s3.mjs (path-style URLs)
//   file:///<folder>                                       a folder, for one node (Redis as the
//                                                          store, the blobs on a volume)
//   unset                                                  none: the blobs stay in the store
//
// Each one is the same interface, whichever the operator picked:
//
//   put(key, data)                  a blob (a Buffer or text), replacing any of that key
//   read(key, { offset, length })   its bytes from `offset` (`length` of them at most), or null
//                                   when there is none
//   size(key)                       its size in bytes, or null when there is none
//   delete(key)                     gone, whether it was there or not
//   close()
//
// Keys are s3.mjs checkKey()'s, on every backend: `/`-separated, nothing climbing out.
//
// S3's credentials (BLOB_ACCESS_KEY_ID, BLOB_SECRET_ACCESS_KEY, or their _FILE forms) are never
// in the URL. The secret key is a secret of the service holding it: its store refuses it in a
// value and redacts it from a blob, its log redacts it (blobSecrets()), and blob storage itself
// redacts its service's secrets from what it is given, as the store does.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomicAsync } from "./files.mjs";
import { MIN_LENGTH } from "./redact.mjs";
import { checkKey, s3Client } from "./s3.mjs";
import { fileName } from "./store-file.mjs";
import { redactedBlob } from "./store.mjs";

export class BlobError extends Error {
  name = "BlobError";
}

// One credential, from NAME or the file NAME_FILE names (a Kubernetes Secret's), never both.
function credential(env, name, read) {
  const value = env[name] || "";
  const file = env[`${name}_FILE`] || "";
  if (value && file) throw new BlobError(`${name} and ${name}_FILE: set one of them, not both`);
  if (!file) return value;
  try {
    return read(file, "utf8").trim();
  } catch (error) {
    throw new BlobError(`${name}_FILE: can't read ${file} (${error.code ?? error.message})`);
  }
}

// The blob storage's credentials → { accessKeyId, secretAccessKey }, or null when neither is set.
// `read`: the tests'.
export function blobCredentials(env, { read = readFileSync } = {}) {
  const accessKeyId = credential(env, "BLOB_ACCESS_KEY_ID", read);
  const secretAccessKey = credential(env, "BLOB_SECRET_ACCESS_KEY", read);
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accessKeyId || !secretAccessKey) {
    throw new BlobError("BLOB_ACCESS_KEY_ID and BLOB_SECRET_ACCESS_KEY: set both, or neither");
  }
  // Shorter, redact() would leave it as it is (an ordinary word): neither refused in the store
  // nor redacted from the blobs and the log. Fail closed rather than hold it unprotected.
  if (secretAccessKey.length < MIN_LENGTH) {
    throw new BlobError(
      `BLOB_SECRET_ACCESS_KEY: ${MIN_LENGTH} characters at least, so that it can be redacted`,
    );
  }
  return { accessKeyId, secretAccessKey };
}

// What the service's store and log keep out of the credentials: the secret key (the key's id
// names it, as a user name does).
export const blobSecrets = (credentials) => (credentials ? [credentials.secretAccessKey] : []);

// BLOB_URL's s3:// → s3Client()'s options, without the credentials.
function s3Options(parsed) {
  if (parsed.username || parsed.password) {
    throw new BlobError(
      "BLOB_URL: no credentials in the URL (BLOB_ACCESS_KEY_ID, BLOB_SECRET_ACCESS_KEY)",
    );
  }
  const unknown = [...parsed.searchParams.keys()].filter((k) => k !== "endpoint" && k !== "region");
  if (unknown.length) {
    throw new BlobError(`BLOB_URL: unknown ${unknown.join(", ")} (endpoint= and region= only)`);
  }
  const endpoint = parsed.searchParams.get("endpoint");
  if (!endpoint) throw new BlobError("BLOB_URL: s3:// needs ?endpoint=https://…");
  const region = parsed.searchParams.get("region") || undefined;
  let prefix;
  try {
    prefix = decodeURIComponent(parsed.pathname);
  } catch {
    throw new BlobError("BLOB_URL: not a valid prefix");
  }
  return {
    endpoint,
    bucket: parsed.hostname,
    prefix,
    ...(region && { region }),
  };
}

// The blob storage BLOB_URL names (see the top). `store`: the service's, which keeps the blobs
// when `url` is unset; `credentials`: blobCredentials()'s; `secrets()`: what its blobs are
// redacted of (the store's own already are); `s3`: more of s3Client()'s options (the tests'
// `lookup`, `timeoutMs`).
export function openBlobs(url, { store, credentials = null, secrets = () => [], s3 = {} } = {}) {
  if (!url) {
    if (!store) throw new BlobError("BLOB_URL unset, and no store to keep the blobs in");
    return checked(storeBlobs(store), { kind: "store", where: "the store" });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlobError("BLOB_URL: not a URL (s3://<bucket>?endpoint=… or file:///<folder>)");
  }
  if (parsed.protocol === "file:") {
    if (parsed.search || parsed.hash) {
      throw new BlobError("BLOB_URL: file:///<folder> alone, nothing after it (? or #)");
    }
    let dir;
    try {
      dir = fileURLToPath(parsed);
    } catch (error) {
      throw new BlobError(`BLOB_URL: ${error.message}`);
    }
    return checked(redacting(fileBlobs(dir), secrets), { kind: "file", where: dir });
  }
  if (parsed.protocol === "s3:") {
    const options = s3Options(parsed);
    if (!credentials) {
      throw new BlobError(
        "BLOB_URL: s3:// needs BLOB_ACCESS_KEY_ID and BLOB_SECRET_ACCESS_KEY (or their _FILE forms)",
      );
    }
    let client;
    try {
      client = s3Client({ ...options, ...credentials, ...s3 });
    } catch (error) {
      throw new BlobError(`BLOB_URL: ${error.message.replace(/^S3: /, "")}`);
    }
    const where = `bucket ${options.bucket} at ${new URL(options.endpoint).origin}`;
    return checked(redacting(s3Blobs(client), secrets), { kind: "s3", where });
  }
  throw new BlobError(`BLOB_URL: ${parsed.protocol} isn't blob storage (s3: or file:)`);
}

// Every backend's keys checked alike, and what it is (`kind`, `where`, for the start's line:
// nothing secret).
function checked(blobs, info) {
  const keyed =
    (fn) =>
    async (key, ...rest) => {
      try {
        checkKey(key);
      } catch (error) {
        throw new TypeError(error.message.replace(/^S3: /, "blobs: "));
      }
      return fn(key, ...rest);
    };
  // A range as s3.mjs takes it, on every backend: non-negative safe integers (a negative or
  // fractional length would mean something else to subarray() or to a file's read).
  const read = keyed(async (key, range = {}) => {
    const { offset = 0, length } = range;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("blobs: not an offset");
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      throw new TypeError("blobs: not a length");
    }
    return blobs.read(key, { offset, ...(length !== undefined && { length }) });
  });
  return {
    ...info,
    put: keyed(blobs.put),
    read,
    size: keyed(blobs.size),
    delete: keyed(blobs.delete),
    close: blobs.close,
  };
}

// `blobs`, whose puts are redacted of `secrets()`.
const redacting = (blobs, secrets) => ({
  ...blobs,
  put: async (key, data) => blobs.put(key, redactedBlob(data, secrets())),
});

// The store's blobs (lib/store.mjs), as they are kept without BLOB_URL. Closing it is its
// service's.
export function storeBlobs(store) {
  return {
    put: async (key, data) => store.putBlob(key, data),
    read: async (key, { offset = 0, length } = {}) =>
      store.readBlob(key, { offset, ...(length !== undefined && { length }) }),
    size: async (key) => store.blobSize(key),
    delete: async (key) => {
      await store.deleteBlob(key);
    },
    close: async () => {},
  };
}

// S3's (s3.mjs): one PUT, ranged GETs, HEAD and DELETE.
export function s3Blobs(client) {
  return {
    put: (key, data) => client.put(key, data),
    read: (key, range = {}) => client.get(key, range),
    size: (key) => client.head(key),
    delete: async (key) => {
      await client.delete(key);
    },
    close: async () => client.close(),
  };
}

// A folder's: each key a file directly in it, named as the store names its blobs' files
// (store-file.mjs fileName(): flat, encoded, hashed when long), so that a key and a key under it
// (`logs/r1`, `logs/r1/2`) both exist, as on S3, and a long one fits the file system's 255 bytes.
// A put writes a file beside it and renames it over, so a reader sees the blob before or after,
// never half of it.
export function fileBlobs(dir) {
  const path = (key) => join(dir, fileName(key));
  const missing = (error) => error.code === "ENOENT";
  return {
    async put(key, data) {
      await mkdir(dir, { recursive: true });
      await writeFileAtomicAsync(path(key), data);
    },

    async read(key, { offset = 0, length = Infinity } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("blobs: not an offset");
      let file;
      try {
        file = await open(path(key), "r");
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      try {
        const { size } = await file.stat();
        const count = Math.max(0, Math.min(length, size - offset));
        const buffer = Buffer.alloc(count);
        let read = 0;
        while (read < count) {
          const { bytesRead } = await file.read(buffer, read, count - read, offset + read);
          if (!bytesRead) break;
          read += bytesRead;
        }
        return buffer.subarray(0, read);
      } finally {
        await file.close();
      }
    },

    async size(key) {
      try {
        const found = await stat(path(key));
        return found.isFile() ? found.size : null;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await rm(path(key), { force: true });
    },

    close: async () => {},
  };
}

// Why a check's S3 error happened, in the operator's words.
const HINTS = {
  InvalidAccessKeyId: "the access key isn't known there",
  SignatureDoesNotMatch: "the secret key is wrong, or the region",
  AccessDenied: "the key may not write there",
  NoSuchBucket: "no such bucket",
  AuthorizationHeaderMalformed: "the region is wrong",
};

// The check at start: an object written, read back, measured and deleted, under
// `.deckhand-check/`. A setting that fails throws a BlobError saying what failed, so that the
// service stops at once rather than at a run's end (fail closed). Once written, the object goes
// whatever fails after (a key that may write but not read), its own delete's failure aside. The
// store's blobs aren't checked: the store is the service's own.
export async function checkBlobs(blobs) {
  if (blobs.kind === "store") return;
  const key = `.deckhand-check/${randomBytes(8).toString("hex")}`;
  const data = randomBytes(32);
  const step = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      const hint = HINTS[error.code];
      throw new BlobError(
        `BLOB_URL (${blobs.where}): can't ${what} an object: ${error.message}${hint ? ` (${hint})` : ""}`,
      );
    }
  };
  await step("write", () => blobs.put(key, data));
  let back;
  let size;
  let deleted = false;
  try {
    back = await step("read", () => blobs.read(key, { offset: 0 }));
    size = await step("measure", () => blobs.size(key));
    await step("delete", () => blobs.delete(key));
    deleted = true;
  } finally {
    if (!deleted) await blobs.delete(key).catch(() => {});
  }
  if (!back || !data.equals(back) || size !== data.length) {
    throw new BlobError(`BLOB_URL (${blobs.where}): an object written reads back otherwise`);
  }
}

// What a service says at start when its blobs take Redis's memory: a store on Redis and no
// BLOB_URL. `what`: its blobs, in words (a sentence's start). Null otherwise.
export function blobWarning(storeUrl, blobUrl, what = "The blobs") {
  if (blobUrl || !/^rediss?:/i.test(storeUrl ?? "")) return null;
  return `${what} take Redis's memory: set BLOB_URL to keep them out of it (docs/setup.md, Blob storage)`;
}

// A service's blob storage as it starts: BLOB_URL's (`env`), checked, and the warnings it says
// (its log, and its /health for the dashboard's status page) → { blobs, warnings }. Throws a
// BlobError when the setting fails: the service stops. `storeUrl`: its store's; `what`: its
// blobs, in words.
export async function startBlobs(env, { store, storeUrl, credentials, secrets, what, log, s3 }) {
  const blobs = openBlobs(env.BLOB_URL, { store, credentials, secrets, s3 });
  await checkBlobs(blobs);
  const warning = blobWarning(storeUrl, env.BLOB_URL, what);
  if (warning) (log.warn ?? log)(warning);
  else if (blobs.kind !== "store") log(`Blob storage: ${blobs.kind}, ${blobs.where}`);
  return { blobs, warnings: warning ? [warning] : [] };
}
