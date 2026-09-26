module.exports = {
  testDir: '.',
  timeout: 120000,
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:9118',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
};
