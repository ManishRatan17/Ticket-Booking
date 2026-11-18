// ESLint configuration (the "flat config" format used since ESLint 9).
// ESLint replaced oxlint here because Windows Application Control blocks oxlint's
// unsigned native binary on this machine; ESLint is plain JavaScript.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']), // built output, not our source
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended, // core JavaScript mistakes: unused variables, unreachable code…
      reactHooks.configs.flat.recommended, // Rules of Hooks: no hooks inside if/loops, correct deps
      reactRefresh.configs.vite, // files must export components only, so hot reload keeps state
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser, // window, document, fetch… are defined in the browser
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Components used only in JSX (<App />) would look "unused" without this.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
