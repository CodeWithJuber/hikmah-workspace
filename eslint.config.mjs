import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // The workbench is a separate service with its own dependencies, its own
    // tsconfig and its own test run. It is linted from inside workbench/.
    'workbench/**',
    // Built by scripts/build-sandbox-worker.mjs from sources that are linted.
    'public/sandbox-worker.js',
  ]),
  {
    // React Compiler advisories that predate this branch, in the five legacy
    // components that the chat and runs rework replaces. Held at "warn" rather
    // than silenced so they stay visible, and scoped to these exact files so
    // all new code is still held to the rule. Each entry should disappear as
    // its component is rewritten; the last one to go removes this block.
    files: [
      'components/playground/chat.tsx',
      'components/playground/settings.tsx',
      'components/playground/voice-controls.tsx',
      'components/kernel/context.tsx',
      'components/context-model/studio.tsx',
    ],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    files: ['components/ui/**/*.{ts,tsx}', 'hooks/use-mobile.ts'],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['components/ai-elements/**/*.{ts,tsx}'],
    rules: {
      // Installed with `npx ai-elements add` and kept close to upstream so the
      // installer can be re-run cleanly. These findings are upstream's, not
      // this repository's debt, and forking the files to satisfy them would
      // make every future update a manual merge.
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/component-hook-factories': 'off',
      'react-hooks/static-components': 'off',
    },
  },
]);

export default eslintConfig;
