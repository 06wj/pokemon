import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { externalCompilerWasm, runtimeModelManifest } from './scripts/build-optimizations.ts';

export default defineConfig({
  base: './',
  plugins: [runtimeModelManifest(), externalCompilerWasm(), react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
