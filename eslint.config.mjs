import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat config. Enforces the house style: modern JS (no `var`, arrow functions
 * over `function` declarations), plus the typescript-eslint recommended set.
 * Type-aware rules are intentionally off to keep `yarn lint` fast — `tsc`
 * already does the deep type checking in `yarn typecheck`.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'tests/fixtures/**', '.yarn/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      // The house style: arrow functions, not `function` declarations. Methods
      // (class/object shorthand) are unaffected.
      'func-style': ['error', 'expression', { allowArrowFunctions: true }],
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // We use `T | undefined` deliberately with exactOptionalPropertyTypes.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // App code: Electron main + core run in Node; the renderer runs in the browser.
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Build scripts are Node ESM modules.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
