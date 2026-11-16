import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // ssh2's optional native addons can't be bundled. Where a C++ toolchain built them
      // (e.g. CI), keep them out of the bundle; ssh2 falls back to its pure-JS code.
      // (Merged with Forge's own externals.)
      external: [/\.node$/, 'cpu-features'],
    },
  },
});
