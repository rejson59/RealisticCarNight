import js from '@eslint/js';
export default [
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
];
