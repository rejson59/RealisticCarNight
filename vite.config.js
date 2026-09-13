import { defineConfig } from 'vite';

/**
 * GitHub Pages serves the site from a subdirectory
 * (https://rejson59.github.io/RealisticCarNight/), so the production build has
 * to emit *relative* asset URLs. With the default base '/' the built
 * index.html points at /assets/index-*.js, which resolves to the domain root
 * and 404s — that is exactly the "page with text but no game" symptom.
 *
 * Dev keeps '/' so HMR and the module graph behave normally.
 */
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',

  build: {
    // three.js is big and rarely changes: split it out so returning players
    // only re-download the game chunk
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },

  server: { host: '0.0.0.0', port: 5173 },
  preview: { host: '0.0.0.0', port: 5173 },
}));
