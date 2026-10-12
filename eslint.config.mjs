
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // Add custom rules here if needed, e.g.:
      // '@typescript-eslint/no-unused-vars': 'warn',
    },
  }
);