// The built dashboard (../dashboard/dist/): index.html at "/", its hashed assets under
// /assets/. Only files inside the folder, resolved first, so ".." and symlinks can't leave it.
import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

// The file `pathname` names under `root`, or null: unknown, outside, or not a file.
export function resolveAsset(root, pathname) {
  let name;
  try {
    name = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return null;
  }
  if (name.includes("\0") || !TYPES[extname(name)]) return null;
  try {
    const base = realpathSync(root);
    const path = realpathSync(join(base, name));
    if (!path.startsWith(base + sep) || !statSync(path).isFile()) return null;
    return path;
  } catch {
    return null;
  }
}

// Serves `pathname` from `root`; false when there is no such file. index.html is read anew
// each time, so a new build shows on the next load; hashed assets are cached for good.
export function serveAsset(res, root, pathname) {
  const path = resolveAsset(root, pathname);
  if (!path) return false;
  const immutable = path.startsWith(join(realpathSync(root), "assets") + sep);
  res.writeHead(200, {
    "content-type": TYPES[extname(path)],
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
  });
  createReadStream(path).pipe(res);
  return true;
}
