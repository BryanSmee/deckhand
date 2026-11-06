// A worker pool: at most `limit` calls of `fn` at once, each worker taking the next item as
// its last call ends (#974). One copy for the listener's bounded reads (machines' offers, the
// repositories' list, the pull requests' CI and mergeability).

// `fn` over `items`, `limit` at once at most, its results in their order. A call that throws
// rejects it, the calls already started going on.
export async function mapLimited(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
