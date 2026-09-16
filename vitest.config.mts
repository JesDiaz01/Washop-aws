import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      LOG_LEVEL: 'silent',
      AWS_REGION: 'us-east-1',
      RAW_EVENTS_BUCKET: 'test-raw-events',
      EVENTS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-events',
      EVENTS_TABLE: 'test-events',
      SUMMARY_TABLE: 'test-location-summary',
    },
  },
});
