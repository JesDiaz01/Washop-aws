import { PublishCommand } from '@aws-sdk/client-sns';
import type { SiteAlert } from '../domain/connectivity';
import { requireEnv } from '../shared/config';
import { getSnsClient } from './clients';

/** Sends a human-readable alert to the site alerts SNS topic; email subscribers receive it as-is. */
export async function publishSiteAlert(alert: SiteAlert): Promise<void> {
  await getSnsClient().send(
    new PublishCommand({
      TopicArn: requireEnv('SITE_ALERTS_TOPIC_ARN'),
      Subject: alert.subject,
      Message: alert.message,
    }),
  );
}
