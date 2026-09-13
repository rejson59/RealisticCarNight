import js from '@eslint/js';
export default [
  // build output and local scratch scripts are not part of the reviewed source
  { ignores: ['dist/**', 'node_modules/**', '.scratch/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {
      window: 'readonly', document: 'readonly', navigator: 'readonly', screen: 'readonly',
      innerWidth: 'readonly', innerHeight: 'readonly', requestAnimationFrame: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
      clearInterval: 'readonly', console: 'readonly', localStorage: 'readonly',
      devicePixelRatio: 'readonly', performance: 'readonly', location: 'readonly',
      HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLCanvasElement: 'readonly',
      AudioContext: 'readonly', webkitAudioContext: 'readonly', Image: 'readonly',
      URL: 'readonly', Blob: 'readonly', matchMedia: 'readonly',
    } },
    rules: { 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^void$' }] },
  },
  {
    // service worker runs in its own global scope
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: {
      self: 'readonly', caches: 'readonly', fetch: 'readonly', console: 'readonly',
      Response: 'readonly', Request: 'readonly', URL: 'readonly', addEventListener: 'readonly',
      clients: 'readonly', skipWaiting: 'readonly', registration: 'readonly',
    } },
  },
  {
    // node-side scripts and the headless test suite
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {
      console: 'readonly', process: 'readonly', globalThis: 'writable',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
      clearInterval: 'readonly', URL: 'readonly', Date: 'readonly',
      TextEncoder: 'readonly', TextDecoder: 'readonly', fetch: 'readonly',
      localStorage: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly',
      navigator: 'readonly', document: 'readonly', requestAnimationFrame: 'readonly',
    } },
    rules: { 'no-unused-vars': ['warn', { args: 'none' }] },
  },
];
