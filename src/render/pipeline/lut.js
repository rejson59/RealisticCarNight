import * as THREE from 'three';

/**
 * Procedural 3D LUTs (32³) for the "grading" stage of the pipeline.
 *
 * The LUT works in display-referred (sRGB-encoded, post-tonemap) space, which
 * is where filmic looks are authored: contrast curve, split toning, saturation
 * and soft black/white roll-off. Generated on the GPU-free side (plain JS) so
 * there are no external .cube assets — same philosophy as the rest of the game.
 */
const SIZE = 32;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** gentle S-curve in gamma space (filmic contrast without clipping) */
function sCurve(c, amount) {
  const s = smooth(clamp01(c));
  return lerp(c, s, amount);
}

function splitTone(c, shadowTint, highTint, amount) {
  const l = luma(c[0], c[1], c[2]);
  const sw = Math.pow(1 - l, 2.2) * amount;
  const hw = Math.pow(l, 2.2) * amount;
  return [
    c[0] * lerp(1, shadowTint[0], sw) * lerp(1, highTint[0], hw),
    c[1] * lerp(1, shadowTint[1], sw) * lerp(1, highTint[1], hw),
    c[2] * lerp(1, shadowTint[2], sw) * lerp(1, highTint[2], hw),
  ];
}

function saturate(c, amount) {
  const l = luma(c[0], c[1], c[2]);
  return [
    lerp(l, c[0], amount),
    lerp(l, c[1], amount),
    lerp(l, c[2], amount),
  ];
}

export const LUT_PROFILES = {
  /** Natural / photographic: muted palette, soft contrast, real-material feel */
  natural: {
    contrast: 0.34, sat: 0.9, split: 0.5,
    shadowTint: [0.94, 1.03, 1.07], highTint: [1.05, 1.0, 0.94],
    blackLift: 0.012, whiteRoll: 0.985,
  },
  /** Cinematic teal & orange, deeper blacks — the "movie still" look */
  film: {
    contrast: 0.5, sat: 0.86, split: 0.9,
    shadowTint: [0.86, 1.04, 1.12], highTint: [1.1, 0.98, 0.86],
    blackLift: 0.006, whiteRoll: 0.975,
  },
  /** Legacy neon-vivid game look */
  vivid: {
    contrast: 0.3, sat: 1.18, split: 0.35,
    shadowTint: [0.9, 1.02, 1.1], highTint: [1.06, 0.99, 0.93],
    blackLift: 0.0, whiteRoll: 1.0,
  },
  /** bypass */
  none: null,
};

function grade(rgb, p) {
  // 1) filmic contrast S-curve in gamma space
  let c = [sCurve(clamp01(rgb[0]), p.contrast),
           sCurve(clamp01(rgb[1]), p.contrast),
           sCurve(clamp01(rgb[2]), p.contrast)];
  // 2) split toning (cool shadows / warm highlights) and saturation
  c = splitTone(c, p.shadowTint, p.highTint, p.split);
  c = saturate(c, p.sat);
  // 3) toe + shoulder LAST, so tints can never push whites back to 1.0 and the
  //    blacks always sit on blackLift (that is what "milky film black" is)
  return c.map((v) => clamp01(clamp01(v) * p.whiteRoll + p.blackLift));
}
// NOTE: micro-contrast / local detail is deliberately *not* in the LUT — a 3D
// LUT is a per-colour transform and cannot see neighbouring pixels. Local
// contrast lives in the CAS step of the present pass, where it belongs.

/* -------------------------------------------------------------------------
 * Half-float encoding.
 *
 * A float32 3D LUT needs OES_texture_float_linear for trilinear filtering, and
 * that extension is missing on a chunk of mobile GPUs (the result is undefined
 * sampling = black or banded grading). HALF_FLOAT linear filtering *is* core in
 * WebGL2 and 11 mantissa bits give ~2048 steps in [0,1] — far beyond the 256 of
 * an 8-bit table, which bands in night gradients. So we bake the table as RGB16F.
 */

/** IEEE-754 binary32 → binary16 (values here are in [0,1], so no inf/NaN games) */
export function floatToHalf(value) {
  const f32 = FLOAT_BITS;
  f32[0] = value;
  const x = UINT_BITS[0];
  let bits = (x >> 16) & 0x8000;                    // sign
  let m = (x >> 12) & 0x07ff;                       // mantissa + guard bits
  const e = (x >> 23) & 0xff;                       // exponent
  if (e < 103) return bits;                         // underflow -> ±0
  if (e > 142) {                                    // overflow -> ±inf
    bits |= 0x7c00;
    bits |= e === 255 ? 0 : 1;
    return bits;
  }
  if (e < 113) {                                    // subnormal
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) + (m >> 1);
  bits += m & 1;                                    // round to nearest even
  return bits;
}

/** binary16 → binary32 (used by the tests to read the table back) */
export function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x03ff;
  if (e === 0) return sign * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * Math.pow(2, e - 15) * (1 + m / 1024);
}

const FLOAT_BITS = new Float32Array(1);
const UINT_BITS = new Uint32Array(FLOAT_BITS.buffer);

/** @returns {THREE.Data3DTexture} sampler3D-ready LUT for a profile */
export function buildLUT(profile) {
  const p = profile in LUT_PROFILES ? LUT_PROFILES[profile] : LUT_PROFILES.natural;
  // RGB16F table: 8-bit bands in dark gradients, float32 is not filterable
  // everywhere — half float is core in WebGL2 and precise enough for grading
  const data = new Uint16Array(SIZE * SIZE * SIZE * 4);
  let i = 0;
  for (let bIdx = 0; bIdx < SIZE; bIdx++) {
    for (let gIdx = 0; gIdx < SIZE; gIdx++) {
      for (let rIdx = 0; rIdx < SIZE; rIdx++) {
        const rgb = [rIdx / (SIZE - 1), gIdx / (SIZE - 1), bIdx / (SIZE - 1)];
        const out = p ? grade(rgb, p) : rgb;
        data[i++] = floatToHalf(out[0]);
        data[i++] = floatToHalf(out[1]);
        data[i++] = floatToHalf(out[2]);
        data[i++] = floatToHalf(1);
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export const LUT_SIZE = SIZE;
