// Fixed-capacity sliding-window rate limiter. Each key keeps the timestamps of
// its recent hits; a hit is allowed while fewer than `limit` hits fall inside
// the trailing `windowMs`. Unlike a fixed window this cannot be gamed by
// bursting `limit` hits at the end of one window and again at the start of the
// next, and a blocked caller learns exactly how long to wait.
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();

  // Buckets are pruned lazily on access; this sweep only exists so keys that go
  // quiet stop occupying memory for the life of the process.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length === 0) hits.delete(key);
      else if (live.length !== times.length) hits.set(key, live);
    }
  }, windowMs);
  sweep.unref?.();

  return {
    limit,
    windowMs,
    // Returns { allowed, remaining, retryAfterMs } without consuming a slot
    // when the caller is over the limit.
    check(key, now = Date.now()) {
      const times = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(0, times[0] + windowMs - now),
        };
      }
      times.push(now);
      hits.set(key, times);
      return { allowed: true, remaining: limit - times.length, retryAfterMs: 0 };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
