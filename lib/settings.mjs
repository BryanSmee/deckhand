// A service's settings, from the environment and its YAML file: each service declares a table of
// them (the listener's: config.mjs SETTINGS) and reads it the same way. In the table, each one
// has
// - type: the YAML its file takes: scalar unless it says list or boolean;
// - default: its value when unset, or a function of the values before it;
// - parse: its text into its value, or a ConfigError naming it (`label`); none: the text;
// - empty: an empty value means something (no label), so set in the environment, even empty,
//   it wins.
import { readFileSync } from "node:fs";
import { isMap, parseYaml } from "./yaml.mjs";

export class ConfigError extends Error {}

// "a, B,,c" → ["a", "b", "c"]: GitHub logins and repo names are case-insensitive.
export function list(value) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// What a settings file may set, and the YAML it takes: each setting's environment variable, in
// lowercase as the key.
export function fileTypes(specs) {
  return Object.fromEntries(
    Object.entries(specs).map(([name, { type }]) => [name, type ?? "scalar"]),
  );
}

const TYPE_FORMAT = {
  list: "a list",
  scalar: "a value (not a list or a mapping)",
  boolean: "true or false",
};

// One value of the file as the environment would hold it, or undefined when it has the wrong
// type: the setting's parser then checks it as it checks the variable.
function fileValue(value, type) {
  const scalar = (v) => typeof v === "string" || typeof v === "number";
  if (type === "list" && Array.isArray(value) && value.every(scalar)) return value.join(",");
  if (type === "boolean" && typeof value === "boolean") return value ? "on" : "off";
  if (scalar(value)) return String(value);
}

// A settings file's text → { path, settings: { ALLOWED_USERS: "a,b", … } }. Fails closed: any
// unknown key, wrong type or key `refused(key, NAME)` says why not (a secret, a setting that
// moved) refuses to start, every one named. `types`: fileTypes()'s.
export function parseSettingsFile(text, path, { types, refused = () => null }) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${path}: ${error.message}`);
  }
  if (raw === null) return { path, settings: {} };
  if (!isMap(raw))
    throw new ConfigError(`${path}: expected settings (key: value) at the top level`);
  const settings = {};
  const errors = [];
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toUpperCase();
    const type = key === name.toLowerCase() ? types[name] : undefined;
    const why = refused(key, name);
    if (why) {
      errors.push(`${key}: ${why}`);
    } else if (!type) {
      errors.push(`${key}: unknown (secrets and compose.yaml's wiring are environment only)`);
    } else if (value !== null) {
      const text = fileValue(value, type);
      if (text === undefined) errors.push(`${key}: expected ${TYPE_FORMAT[type]}`);
      else settings[name] = text;
    }
  }
  if (errors.length) throw new ConfigError(`${path}: ${errors.join("; ")}`);
  return { path, settings };
}

// No settings file.
export const NO_FILE = { path: null, settings: {} };

// Where the services' settings file is when CONFIG_FILE doesn't say (the server folder's).
const CONFIG_PATH = "/etc/deckhand/config.yaml";

// A few settings, for a service that reads nothing else of the settings file (the broker, the
// policy service): `specs` as readSettings() takes them, each from the environment, else its key
// in the file (CONFIG_FILE, else `path`; read once), else its default. The file's other keys are
// another service's, which checks them; one of these with the wrong type is refused here too.
export function readSomeSettings(env, specs, { path = CONFIG_PATH, read } = {}) {
  const types = fileTypes(specs);
  const file = readSettingsFile(env, {
    path,
    ...(read && { read }),
    parse: (text, path) => {
      let raw;
      try {
        raw = parseYaml(text);
      } catch (error) {
        throw new ConfigError(`${path}: ${error.message}`);
      }
      const settings = {};
      const errors = [];
      for (const name of Object.keys(specs)) {
        const key = name.toLowerCase();
        const value = isMap(raw) ? raw[key] : null;
        if (value == null) continue;
        const text = fileValue(value, types[name]);
        if (text === undefined) errors.push(`${key}: expected ${TYPE_FORMAT[types[name]]}`);
        else settings[name] = text;
      }
      if (errors.length) throw new ConfigError(`${path}: ${errors.join("; ")}`);
      return { path, settings };
    },
  });
  return readSettings(env, settingSource(env, file, specs), specs);
}

// The file at env.CONFIG_FILE, else `path`, read once at start (a restart applies an edit),
// through `parse(text, path)`. No file: no settings, unless CONFIG_FILE names one, which then
// has to be there.
export function readSettingsFile(env, { path: fallback, parse, read = readText }) {
  const path = env.CONFIG_FILE || fallback;
  let text;
  try {
    text = read(path);
  } catch (error) {
    if (error.code === "ENOENT" && !env.CONFIG_FILE) return NO_FILE;
    throw new ConfigError(`reading ${path}: ${error.message}`);
  }
  return parse(text, path);
}

const readText = (path) => readFileSync(path, "utf8");

// A set, non-empty environment variable, else the file's key; and how an error names it.
export function settingSource(env, file, specs) {
  const fromEnv = (name) => env[name] != null && (env[name] !== "" || specs[name]?.empty);
  const setting = (name) => (fromEnv(name) ? env[name] : file.settings[name]);
  const label = (name) =>
    fromEnv(name) || !(name in file.settings) ? name : `${file.path}: ${name.toLowerCase()}`;
  return { setting, label };
}

// Every setting's value, in the table's order. Empty is unset, unless it means something.
export function readSettings(env, { setting, label }, specs) {
  const values = {};
  for (const [name, { default: fallback, parse, empty }] of Object.entries(specs)) {
    const text = setting(name);
    if (text === undefined || (text === "" && !empty)) {
      values[name] = typeof fallback === "function" ? fallback(values) : fallback;
    } else {
      values[name] = parse
        ? parse(text, { label: label(name), env, values, labelOf: label })
        : text;
    }
  }
  return values;
}
