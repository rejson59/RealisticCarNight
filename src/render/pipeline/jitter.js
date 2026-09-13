/**
 * Temporal jitter for TAA/TAAU.
 *
 * A rotated Halton(2,3) sequence offsets the projection matrix by a sub-pixel
 * amount every frame. Combined with the history buffer this turns N low-res
 * samples into one converged high-quality image — the classical (pre-ML)
 * ancestor of DLSS-style temporal upscaling.
 */

/** radical inverse base 2 / base 3, returned in [0,1) */
export function halton23(index) {
  let x = 0;
  let f = 0.5;
  let i = index;
  while (i > 0) { x += f * (i % 2); i = Math.floor(i / 2); f *= 0.5; }
  let y = 0;
  let g = 1 / 3;
  let j = index;
  while (j > 0) { y += g * (j % 3); j = Math.floor(j / 3); g /= 3; }
  return [x, y];
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * 16-sample rotated Halton(2,3) set. Each sample is in pixels: [-0.5, +0.5].
 * Rotating by the golden angle and wrapping keeps consecutive frames
 * decorrelated without ever leaving the pixel footprint.
 */
export const JITTER_SEQUENCE = (() => {
  const raw = [];
  for (let k = 0; k < 16; k++) {
    const [hx, hy] = halton23(k + 1);
    const a = Math.PI * 2 * GOLDEN * k;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const wrap = (v) => v - Math.floor(v);           // back into [0,1)
    raw.push([wrap(hx * c - hy * s) - 0.5, wrap(hx * s + hy * c) - 0.5]);
  }
  // centre the set: a biased jitter would bake a permanent sub-pixel shift into
  // the accumulated history, then shrink it back inside the pixel footprint
  let mx = 0; let my = 0;
  for (const [x, y] of raw) { mx += x; my += y; }
  mx /= raw.length; my /= raw.length;
  let maxAbs = 0;
  for (const [x, y] of raw) maxAbs = Math.max(maxAbs, Math.abs(x - mx), Math.abs(y - my));
  const k = maxAbs > 0.5 ? 0.5 / maxAbs : 1;
  return raw.map(([x, y]) => [(x - mx) * k, (y - my) * k]);
})();

/**
 * Apply the sub-pixel jitter to a camera.
 *
 * projectionMatrix maps view→clip and clip.w = -viewZ, so an offset written
 * into elements [8]/[9] becomes a *constant* NDC shift — exactly one pixel per
 * 2/size. Call this AFTER camera.updateProjectionMatrix() and BEFORE the frame
 * is rendered; undo it with clearJitter() once the frame is done.
 *
 * @returns {[number, number]} jitter in NDC units
 */
export function applyJitter(camera, frame, internalW, internalH) {
  const [jx, jy] = JITTER_SEQUENCE[frame % JITTER_SEQUENCE.length];
  const nx = (2 * jx) / internalW;
  const ny = (2 * jy) / internalH;
  const e = camera.projectionMatrix.elements;
  e[8] = nx;   // ⇒ NDC.x shifts by -nx
  e[9] = ny;   // ⇒ NDC.y shifts by -ny
  return [nx, ny];
}

export function clearJitter(camera) {
  const e = camera.projectionMatrix.elements;
  if (e[8] !== 0 || e[9] !== 0) {
    e[8] = 0;
    e[9] = 0;
  }
}
