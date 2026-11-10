// A run's screenshots: what a sandbox may upload (the broker's PUT /run/shots/<file>,
// ../broker/files.mjs) and what GET /shots serves (edge's, from the broker: ../edge/shots.mjs).
// The sandbox's deckhand-files keeps a copy of the names (test/shots.test.mjs holds it the same).

// A screenshot's size, and all of a run's: they are public once linked, and kept as long as the
// run's log.
export const MAX_SHOT = 10 * 1024 * 1024;
export const MAX_SHOTS = 100 * 1024 * 1024;

// The names a sandbox may upload, and the folder each run's go in (preparation.mjs makes it).
export const SHOT_NAME = /^[\w.-]+\.(png|jpe?g|webp)$/;
export const SHOT_FOLDER = /^[0-9a-f]{24}$/;

// GET /shots/<folder>/<file>: the names the sandboxes may upload, nothing else. → [, folder,
// file, its type].
export const SHOT_PATH = new RegExp(
  `^/shots/(${SHOT_FOLDER.source.slice(1, -1)})/(${SHOT_NAME.source.slice(1, -1)})$`,
);

// Each type's Content-Type, by its extension.
export const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// What each type's file starts with: a file of another kind isn't served as an image.
const PNG = Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = Buffer.of(0xff, 0xd8, 0xff);
const MAGIC = {
  png: (b) => b.subarray(0, 8).equals(PNG),
  jpg: (b) => b.subarray(0, 3).equals(JPEG),
  jpeg: (b) => b.subarray(0, 3).equals(JPEG),
  webp: (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
};

// Whether `body` is the image `name` says it is (its extension, SHOT_NAME's).
export function isImage(name, body) {
  const type = SHOT_NAME.exec(name)?.[1];
  return !!type && MAGIC[type](body);
}

// The request's body, or null past `max` bytes (the rest isn't read).
export async function readCapped(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
