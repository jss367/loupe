import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  outputDir: '.context/test-results',
  use: {baseURL: 'http://127.0.0.1:8791', viewport: {width: 1280, height: 900}},
  webServer: {
    command: '.venv/bin/python tests/serve_fixture.py',
    url: 'http://127.0.0.1:8791/api/meta',
    reuseExistingServer: false,
  },
});
