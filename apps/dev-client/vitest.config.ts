import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Test the config module with a mock for import.meta.env
    globals: false,
  },
});
