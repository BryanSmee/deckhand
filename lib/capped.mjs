// Caches capped at a number of entries, oldest first out (#887). A Map keeps the order its keys
// were first set in, and setting a key again leaves it there: a fresh value must delete its key
// first, or the entry read longest ago isn't the first to go (#863).

// Sets `key` to `value` in `map` as its last entry, then drops the first ones past `max`.
export function keepLast(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return map;
}
