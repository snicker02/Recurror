// Recurror — small deterministic value noise for brush shape (width jitter, wobble).
// Seeded per stroke so a stroke always redraws identically; loop-periodic variant keeps closed
// strokes seamless where they close.

function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;                 // [0, 1)
}

const fade = (t) => t * t * (3 - 2 * t);

/** 2D value noise in [-1, 1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return 2 * ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) - 1;
}

/** Two octaves along a 1D parameter (s / scale). */
export function noise1(t, seed = 0) {
  return 0.7 * noise2(t, seed * 0.618 + 0.37, seed) + 0.3 * noise2(t * 2.13, seed * 0.618 + 9.1, seed + 17);
}

/**
 * Noise along arc length s with feature size `scale`; when `loopLen` is given the result is periodic
 * in s with that period (sampled on a circle), so a closed stroke meets itself exactly.
 */
export function strokeNoise(s, scale, seed, loopLen = 0) {
  scale = Math.max(1e-3, scale);
  if (loopLen > 0) {
    const R = loopLen / (2 * Math.PI * scale), a = (2 * Math.PI * s) / loopLen;
    const x = R * Math.cos(a), y = R * Math.sin(a);
    return 0.7 * noise2(x, y, seed) + 0.3 * noise2(x * 2.13 + 5.3, y * 2.13 - 1.7, seed + 17);
  }
  return noise1(s / scale, seed);
}

/** Stable small integer seed from a stroke id. */
export function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}
