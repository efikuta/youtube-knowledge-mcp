import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  platform: 'node',
  bundle: true,
  splitting: false,
  treeshake: true,
  minify: false,
  outDir: 'build'
});