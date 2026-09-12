import js from '@eslint/js';
export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {
      window: 'readonly', document: 'readonly', navigator: 'readonly', screen: 'readonly',
      innerWidth: 'readonly', innerHeight: 'readonly', requestAnimationFrame: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly',
      HTMLElement: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly',
    } },
    rules: { 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^void$' }] },
  },
];
