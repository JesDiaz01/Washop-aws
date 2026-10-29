import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/integration/**'], // need a deployed stack: npm run test:integration
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
    },
  },
});
