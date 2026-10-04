import { defineConfig } from '@vscode/test-cli';

// Nur für den ausdrücklich gestarteten Diagnosebefehl (npm run test:diagnostic).
// Bewusst nicht in .vscode-test.mjs und damit nicht in npm test oder im CI-Testjob.
export default defineConfig({
	files: 'out/test/diagnostics/*.diagnostic.js',
	workspaceFolder: '.'
});
