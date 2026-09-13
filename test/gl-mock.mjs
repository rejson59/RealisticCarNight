/**
 * Minimal WebGL2 context mock built on a Proxy.
 *
 * three.js only needs the context to *behave* consistently (enums stable,
 * shader/program status "ok", framebuffer complete, getters plausible) — every
 * actual GL command can be a no-op. That is enough to run the real renderer,
 * the real EffectComposer chain and the real game boot in Node, which catches
 * every JS-level mistake a browser would otherwise report as a blank canvas.
 *
 * GLSL itself is validated separately by test/shaders.mjs (glslangValidator).
 */

const ENUM_START = 0x1000;

/** numeric answers for the getParameter queries three.js makes */
function paramValue(name) {
  if (name === 'VERSION') return 'WebGL 2.0';
  if (name === 'SHADING_LANGUAGE_VERSION') return 'WebGL GLSL ES 3.00';
  if (name === 'VENDOR') return 'Arena Mock';
  if (name === 'RENDERER') return 'Mock WebGL2 (software)';
  if (name === 'UNMASKED_VENDOR_WEBGL') return 'Arena Mock';
  if (name === 'UNMASKED_RENDERER_WEBGL') return 'Mock WebGL2 (software)';
  if (name === 'ALIASED_LINE_WIDTH_RANGE' || name === 'ALIASED_POINT_SIZE_RANGE') {
    return new Float32Array([1, 8]);
  }
  if (name === 'MAX_VIEWPORT_DIMS') return new Int32Array([8192, 8192]);
  if (name === 'SCISSOR_BOX' || name === 'VIEWPORT') return new Int32Array([0, 0, 1280, 720]);
  if (name === 'COLOR_CLEAR_VALUE') return new Float32Array([0, 0, 0, 0]);
  if (name === 'DEPTH_BITS') return 24;
  if (name === 'STENCIL_BITS') return 0;
  if (name === 'MAX_SAMPLES') return 8;
  if (name === 'MAX_TEXTURE_MAX_ANISOTROPY_EXT') return 16;
  if (name === 'FRAMEBUFFER_BINDING' || name === 'CURRENT_PROGRAM') return null;
  if (name === 'GPU_DISJOINT_EXT') return false;
  if (name.startsWith('MAX_')) return 4096;
  return 0;
}

export function createWebGL2Mock(canvas) {
  const enumByName = new Map();
  const nameByEnum = new Map();
  const fnCache = new Map();
  const objects = new Map();   // "kind" -> object identity is irrelevant, but keep them unique

  const enumFor = (name) => {
    if (!enumByName.has(name)) {
      const value = ENUM_START + enumByName.size;
      enumByName.set(name, value);
      nameByEnum.set(value, name);
    }
    return enumByName.get(name);
  };

  const target = {
    canvas,
    drawingBufferWidth: canvas?.width || 1280,
    drawingBufferHeight: canvas?.height || 720,
    drawingBufferColorSpace: 'srgb',

    getContextAttributes: () => ({
      alpha: true, depth: true, stencil: false, antialias: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
      desynchronized: false, xrCompatible: false,
    }),
    isContextLost: () => false,
    getError: () => 0,
    getSupportedExtensions: () => [
      'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_texture_filter_anisotropic',
      'OES_texture_float_linear', 'WEBGL_debug_renderer_info', 'EXT_disjoint_timer_query_webgl2',
    ],
    getExtension: (name) => ({
      // anisotropic + debug info expose their own enum constants
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: enumFor('MAX_TEXTURE_MAX_ANISOTROPY_EXT'),
      TEXTURE_MAX_ANISOTROPY_EXT: enumFor('TEXTURE_MAX_ANISOTROPY_EXT'),
      UNMASKED_VENDOR_WEBGL: enumFor('UNMASKED_VENDOR_WEBGL'),
      UNMASKED_RENDERER_WEBGL: enumFor('UNMASKED_RENDERER_WEBGL'),
      FRAMEBUFFER_ATTACHMENT_TEXTURE_SAMPLES_EXT: enumFor('FRAMEBUFFER_ATTACHMENT_TEXTURE_SAMPLES_EXT'),
      __name: name,
    }),

    getParameter: (pname) => paramValue(nameByEnum.get(pname) || `UNKNOWN_${pname}`),

    // shaders / programs: always compile and link (GLSL is checked elsewhere)
    createShader: () => ({ __mock: 'shader' }),
    createProgram: () => ({ __mock: 'program' }),
    getShaderParameter: () => true,
    getProgramParameter: (program, pname) => {
      const name = nameByEnum.get(pname);
      if (name === 'LINK_STATUS' || name === 'VALIDATE_STATUS' || name === 'COMPILE_STATUS') return true;
      if (name === 'ACTIVE_UNIFORMS' || name === 'ACTIVE_ATTRIBUTES' || name === 'TRANSFORM_FEEDBACK_VARYINGS') return 0;
      if (name === 'ACTIVE_UNIFORM_MAX_LENGTH' || name === 'ACTIVE_ATTRIBUTE_MAX_LENGTH') return 0;
      return 0;
    },
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getShaderSource: () => '',
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformLocation: () => ({ __mock: 'uniform-location' }),
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
    getActiveUniformBlockParameter: () => 0,
    getActiveUniformBlockName: () => '',

    // framebuffers are always complete
    checkFramebufferStatus: () => enumFor('FRAMEBUFFER_COMPLETE'),

    // shader precision: highp everywhere (desktop-class GPU)
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),

    // GPU objects
    createBuffer: () => ({ __mock: 'buffer' }),
    createTexture: () => ({ __mock: 'texture' }),
    createFramebuffer: () => ({ __mock: 'framebuffer' }),
    createRenderbuffer: () => ({ __mock: 'renderbuffer' }),
    createVertexArray: () => ({ __mock: 'vao' }),
    createQuery: () => ({ __mock: 'query' }),
    createSampler: () => ({ __mock: 'sampler' }),
    createTransformFeedback: () => ({ __mock: 'tf' }),
    fenceSync: () => ({ __mock: 'sync' }),
    clientWaitSync: () => enumFor('CONDITION_SATISFIED'),
    getQueryParameter: () => 0,
    getSyncParameter: () => 0,
    getFragDataLocation: () => 0,

    readPixels: (x, y, w, h, format, type, pixels) => { if (pixels && pixels.fill) pixels.fill(0); },
    getBufferSubData: () => {},
    getBufferParameter: () => 0,
    getTexParameter: () => 0,
    getRenderbufferParameter: () => 0,
    getFramebufferAttachmentParameter: () => 0,
    getInternalformatParameter: () => null,
    getActiveUniforms: () => [],
  };

  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string') return t[prop];
      if (prop in t) return t[prop];
      // UPPER_SNAKE_CASE => stable GL enum constant
      if (/^[A-Z0-9_]+$/.test(prop)) return enumFor(prop);
      // anything else is a GL command: stable no-op function
      if (!fnCache.has(prop)) fnCache.set(prop, () => undefined);
      return fnCache.get(prop);
    },
    set(t, prop, value) { t[prop] = value; return true; },
    has(t, prop) { return prop in t || /^[A-Z0-9_]+$/.test(String(prop)); },
  });

  objects.clear();
  return proxy;
}
