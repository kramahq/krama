import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.changeset/**', '**/*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // The mock is a dev fixture server with loosely typed request bodies (validated by the contract at the edge).
  { files: ['apps/mock/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false } } },
);
