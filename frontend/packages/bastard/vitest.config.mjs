import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      'alien-signals': path.resolve(__dirname, 'node_modules/alien-signals'),
      xstream: path.resolve(__dirname, 'node_modules/xstream'),
    },
  },
});
