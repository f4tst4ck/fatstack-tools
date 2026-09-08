import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/provider.ts',
    'src/client.ts',
    'src/testing.ts',
    'src/hono.ts',
    'src/express.ts',
    'src/next.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
