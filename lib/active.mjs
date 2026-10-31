// Active/passive (#499, docs/services.md): of a service's two copies, the one holding its lease
// in the store (store.mjs acquire()) acts, the other waits for it. The holder renews it a third
// into its lifetime; the waiting copy asks for it every `pollMs`, so that it takes over at once
// once the holder releases it (on SIGTERM, after its calls in flight), and once it expires after
// a crash. Each holder gets a higher epoch than every one before it: what fences a copy that
// lost its lease without noticing (a long pause, a network cut).

export const LEASE_TTL_MS = 15_000;

// `onActive(lease)` once it holds the lease, `onPassive()` once it no longer does (lost, or
// released by stop()). `holder`: this copy's name, unique.
export function activePassive({
  store,
  name,
  holder,
  ttlMs = LEASE_TTL_MS,
  pollMs = 250,
  onActive = () => {},
  onPassive = () => {},
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
}) {
  let lease = null;
  // When the lease held ends by this copy's own clock, from its last renewal: past it, a copy
  // whose store doesn't answer no longer acts (the other may hold it by then).
  let until = 0;
  let timer = null;
  let stopped = false;
  let ticking = null;

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(tick, ms);
    timer.unref?.();
  }

  async function tick() {
    timer = null;
    ticking = step().finally(() => (ticking = null));
    await ticking;
  }

  // A store call that doesn't answer within half a lifetime fails: its holder may be past it.
  function answered(call) {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimer(() => reject(new Error("the store didn't answer")), ttlMs / 2);
    });
    return Promise.race([call, late]).finally(() => clearTimer(timer));
  }

  async function lose(why) {
    log(`${name}: lease lost (epoch ${lease.epoch}, ${why}), waiting for it again`);
    lease = null;
    await onPassive();
  }

  async function step() {
    try {
      if (lease) {
        const asked = now();
        const renewed = await answered(store.renew(name, holder, lease.epoch, { ttlMs }));
        if (stopped) return;
        if (renewed) {
          lease = renewed;
          until = asked + ttlMs;
        } else await lose("taken or expired");
      } else {
        const asked = now();
        const got = await answered(store.acquire(name, holder, { ttlMs }));
        if (stopped) {
          // stop() came while it was asked: given back, not dropped, so that the other copy
          // doesn't wait out a lifetime for a lease nobody holds.
          if (got) await store.release(name, holder, got.epoch).catch(() => false);
          return;
        }
        if (got) {
          lease = got;
          until = asked + ttlMs;
          log(`${name}: lease taken (epoch ${got.epoch}), this copy acts`);
          await onActive(got);
        }
      }
    } catch (error) {
      log(`${name}: the lease: ${error.message ?? error}`);
      if (lease && now() >= until) await lose("not renewed in time");
    }
    schedule(lease ? ttlMs / 3 : pollMs);
  }

  return {
    start() {
      stopped = false;
      return tick();
    },
    // Released for the next copy to take at once; `onPassive()` first.
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      // A look in flight, for a lifetime at most: a store that no longer answers holds no stop.
      await Promise.race([ticking, new Promise((resolve) => setTimer(resolve, ttlMs).unref?.())]);
      const held = lease;
      lease = null;
      if (!held) return false;
      await onPassive();
      const released = await store.release(name, holder, held.epoch).catch(() => false);
      if (released) log(`${name}: lease released (epoch ${held.epoch})`);
      return released;
    },
    // Held, and by this copy's clock still: a store that no longer answers doesn't keep it.
    active: () => lease !== null && now() < until,
    epoch: () => lease?.epoch ?? null,
  };
}
