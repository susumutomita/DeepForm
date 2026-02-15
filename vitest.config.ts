import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/index.ts',
        'src/types.ts',
        'src/db/types.ts',
        'src/db/index.ts',
        'src/db/dialects/**',
        'src/db/migrations/**',
        'src/llm.ts',
        'src/routes/sessions.ts',
      ],
    },
  },
});
