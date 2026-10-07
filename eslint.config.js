import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.changeset/**',
      '**/*.cjs',
      '**/test/fixtures/**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The mock is a dev fixture server with loosely typed request bodies (validated by the contract at the edge).
  { files: ['apps/mock/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  {
    files: ['apps/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // A Node script that also runs a callback inside the browser it drives.
    files: ['apps/ui/scripts/**/*.mjs', 'scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { 'no-empty': 'off' },
  },
  { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false } } },
);
