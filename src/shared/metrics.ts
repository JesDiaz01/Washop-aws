/**
 * CloudWatch Embedded Metric Format (EMF).
 *
 * Spreading these fields into a log entry makes CloudWatch extract the values as custom metrics,
 * with no PutMetricData calls and no added latency. Without METRICS_NAMESPACE (tests, local runs)
 * the values are still logged, just not turned into metrics.
 */
export function metricFields(metrics: Record<string, number>): Record<string, unknown> {
  const namespace = process.env.METRICS_NAMESPACE;
  if (!namespace) return { ...metrics };

  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [[]], // no dimensions: one series per metric name keeps custom metric cost flat
          Metrics: Object.keys(metrics).map((name) => ({ Name: name, Unit: 'Count' })),
        },
      ],
    },
    ...metrics,
  };
}
