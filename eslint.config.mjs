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
    // The rest of eslint-plugin-jsx-a11y.
    //
    // The plugin is already here: eslint-config-next ships it and turns on six
    // of its rules. These are the other twenty-odd from its recommended set —
    // label-has-associated-control, click-events-have-key-events,
    // tabindex-no-positive and the like — enabled by name rather than by
    // spreading the plugin's own config, because eslint-config-next has already
    // registered the plugin and a second registration makes ESLint refuse to
    // run at all ("Cannot redefine plugin"). That failure reports zero
    // problems, which reads exactly like a clean pass.
    //
    // Static analysis catches about half of what matters and nothing about
    // focus order or whether a label makes sense; the browser checks in
    // scripts/ and a keyboard are the other half.
    files: ['app/**/*.tsx', 'components/**/*.tsx'],
    rules: {
      'jsx-a11y/anchor-has-content': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/autocomplete-valid': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/heading-has-content': 'error',
      'jsx-a11y/html-has-lang': 'error',
      'jsx-a11y/iframe-has-title': 'error',
      'jsx-a11y/img-redundant-alt': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',
      // depth 4, not the default 2. This app writes the accessible pattern — the
      // label WRAPS its control, which associates them implicitly — and puts the
      // text in a <span><strong>…</strong></span> beside it. At the default
      // depth the rule cannot see text that far in, and reported 26 correct
      // labels as missing. Raised, it still catches the real case: a label with
      // no control and no text at all.
      'jsx-a11y/label-has-associated-control': [
        'error',
        {
          // The app writes the accessible pattern: the label WRAPS its control,
          // which associates them implicitly. Two defaults hid that from the
          // rule, and between them they reported 26 correct labels as missing.
          //
          // depth 4, not 2: the text sits in a <span><strong>…</strong></span>
          // beside the control, which the default depth cannot see.
          depth: 4,
          // And the control is often a React component, not a bare <input>, so
          // the rule has no way to know it renders one.
          controlComponents: [
            'Checkbox',
            'Switch',
            'Input',
            'Textarea',
            'Slider',
            'RadioGroupItem',
            'Select',
          ],
        },
      ],
      'jsx-a11y/media-has-caption': 'error',
      'jsx-a11y/mouse-events-have-key-events': 'error',
      'jsx-a11y/no-access-key': 'error',
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/no-distracting-elements': 'error',
      'jsx-a11y/no-interactive-element-to-noninteractive-role': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/no-noninteractive-element-to-interactive-role': 'error',
      // `role="region"` added, next to the rule's own `tabpanel`.
      //
      // This rule and axe-core disagree about a scrolling <div>, and axe is
      // right: an element that overflows and cannot be focused is one a
      // keyboard user cannot scroll at all, which is WCAG 2.1.1, and
      // `tabindex="0"` with a role and a label is the documented fix. The rule
      // already carves out `tabpanel` for the same reason — a container that
      // holds content a keyboard has to reach. `region` is that container with
      // a name.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'] }],
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/scope': 'error',
      'jsx-a11y/tabindex-no-positive': 'error',
    },
  },
  {
    // React Compiler advisories that predate this branch, in the three legacy
    // components that the chat and runs rework replaces. Held at "warn" rather
    // than silenced so they stay visible, and scoped to these exact files so
    // all new code is still held to the rule. Each entry should disappear as
    // its component is rewritten; the last one to go removes this block.
    //
    // A fourth named components/playground/chat.tsx, which the run-loop
    // retirement deleted. A path that matches no file reads as a rule still
    // being relaxed for something, and would have silently absorbed a new file
    // created at that path.
    files: [
      'components/playground/settings.tsx',
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
      // Same reason, for the a11y rules turned on above. input-group.tsx puts a
      // click handler on the wrapper so that tapping the padding focuses the
      // input, and pagination.tsx builds its link content from props; both are
      // upstream's shape, and editing them here makes the next
      // `npx shadcn add --overwrite` a manual merge. Any wrapper of these that
      // Site code writes is still held to the rules.
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/anchor-has-content': 'off',
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
      // And the a11y rules turned on above, for the same reason. The one
      // finding is PromptInputTabLabel, an <h3> whose content arrives through
      // {...props}; upstream carries its own oxlint disable comment on that
      // line saying exactly that.
      'jsx-a11y/heading-has-content': 'off',
    },
  },
]);

export default eslintConfig;
