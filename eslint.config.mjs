import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import next from 'eslint-config-next'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.pgdata/**',
      'prisma/migrations/**',
      '.scratch*/**',
      'next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Brings @next/next, react, react-hooks, import, and jsx-a11y recommended rules.
  ...next,

  {
    rules: {
      // Unused vars are usually a real mistake; allow the _ escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The brief bans `any` in committed code.
      '@typescript-eslint/no-explicit-any': 'error',
      // The brief bans console.log; structured logging only.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Enforce the brief's import rule: Prisma is reachable only from repo files,
  // lib/db, and prisma/. A Prisma call in a page or route handler is a bug.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/modules/**/repo.ts', 'src/lib/db.ts', 'src/lib/rate-limit.ts'],
    rules: {
      // The base rule cannot distinguish a type-only import, so use the
      // typescript-eslint variant with allowTypeImports. The intent is to block
      // DATABASE ACCESS outside repo.ts, not to ban the generated enum types:
      // `import type { Role }` is erased at compile time and touches nothing.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              allowTypeImports: true,
              message:
                'Prisma may only be imported from src/modules/*/repo.ts, src/lib/db.ts, or src/lib/rate-limit.ts. Go through the module public API. (Type-only imports are allowed.)',
            },
          ],
          // Patterns, not just the alias: a relative '../../lib/db' bypassed the
          // path-based rule entirely, which is how the limiter reached the client
          // without a suppression. Both spellings are now covered.
          patterns: [
            {
              group: ['@/lib/db', '**/lib/db'],
              allowTypeImports: true,
              message:
                'Import the db client only in a repo.ts (or lib/rate-limit.ts). Callers use the module public API (index.ts). Relative paths are covered too.',
            },
          ],
        },
      ],
    },
  },

  // Design-system primitives stay pure presentation: no data access.
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/*', '@/server/*', '@/lib/db'],
              message: 'components/ui must be pure presentation.',
            },
          ],
        },
      ],
    },
  },

  // Scripts, tests, and the worker legitimately log to stdout.
  {
    files: ['worker/**/*.ts', 'prisma/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
)
