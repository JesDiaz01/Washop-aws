import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/integration/**'], // need a deployed stack: npm run test:integration
    // npm run test:coverage (CI runs it). The thresholds sit just under the current numbers, so a
    // change that adds untested code fails the build.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
    },
    env: {
      LOG_LEVEL: 'silent',
      AWS_REGION: 'us-east-1',
      RAW_EVENTS_BUCKET: 'test-raw-events',
      EVENTS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-events',
      EVENTS_TABLE: 'test-events',
      SUMMARY_TABLE: 'test-location-summary',
      SITE_ALERTS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:test-site-alerts',
      OFFLINE_AFTER_MINUTES: '10',
      EVENT_BUS_NAME: 'test-event-bus',
      DASHBOARD_CLIENT_ID: 'test-dashboard-client',
    },
  },
});
