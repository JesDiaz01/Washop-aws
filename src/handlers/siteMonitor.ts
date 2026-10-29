import type { Context } from 'aws-lambda';
import { listSiteHeartbeats, recordConnectivityChange, revertConnectivityChange } from '../aws/eventStore';
import { publishSiteAlert } from '../aws/siteAlerts';
import { type Connectivity, connectivityChangeFor, type ReportingSite, siteAlertFor } from '../domain/connectivity';
import { requireEnv } from '../shared/config';
import { createLogger, type Logger, serializeError } from '../shared/logger';
import { metricFields } from '../shared/metrics';

/**
 * Scheduled check (EventBridge Scheduler, every 5 minutes).
 *
 * Marks a site OFFLINE when its controller stops sending heartbeats and ONLINE when they resume,
 * sending one SNS alert per change. The state lives on the location summary item, so the API
 * reports it too.
 */

const logger = createLogger({ service: 'washops-site-monitor' });

type Outcome = 'ALERTED' | 'ALREADY_RECORDED';

async function applyChange(
  site: ReportingSite,
  to: Connectivity,
  now: Date,
  offlineAfterMinutes: number,
  log: Logger,
): Promise<Outcome> {
  // 1) Claim the change with a conditional write, so only one run ever alerts for it...
  if (!(await recordConnectivityChange(site, to, now))) return 'ALREADY_RECORDED';

  // 2) ...then alert. If the alert fails, release the claim so the next run retries it.
  try {
    await publishSiteAlert(siteAlertFor(site, to, now, offlineAfterMinutes));
    return 'ALERTED';
  } catch (error) {
    await revertConnectivityChange(site.locationId, to).catch((revertError: unknown) =>
      log.error('Could not revert connectivity after a failed alert; this alert will not be retried', {
        error: serializeError(revertError),
      }),
    );
    throw error;
  }
}

export const handler = async (_event: unknown, context: Context): Promise<void> => {
  const now = new Date();
  const offlineAfterMinutes = Number(requireEnv('OFFLINE_AFTER_MINUTES'));
  const log = logger.child({ awsRequestId: context.awsRequestId });

  const sites = await listSiteHeartbeats();
  let offlineSites = 0;
  let failed = 0;

  for (const site of sites) {
    const change = connectivityChangeFor(site, now, offlineAfterMinutes);
    if ((change ?? site.connectivity) === 'OFFLINE') offlineSites += 1;
    if (!change || !site.lastHeartbeat) continue;

    const siteLog = log.child({ locationId: site.locationId, lastHeartbeat: site.lastHeartbeat, connectivity: change });
    try {
      const reporting = { locationId: site.locationId, lastHeartbeat: site.lastHeartbeat };
      const outcome = await applyChange(reporting, change, now, offlineAfterMinutes, siteLog);
      if (change === 'OFFLINE') {
        siteLog.warn('Site went offline', { outcome });
      } else {
        siteLog.info('Site back online', { outcome });
      }
    } catch (error) {
      failed += 1;
      siteLog.error('Failed to record or alert a connectivity change; the next run will retry', {
        error: serializeError(error),
      });
    }
  }

  log.info('Site check complete', { sitesChecked: sites.length, failed, ...metricFields({ OfflineSites: offlineSites }) });

  if (failed > 0) {
    // Fails the invocation so the Lambda errors alarm sees it and Scheduler retries the whole check.
    throw new Error(`${failed} connectivity change(s) could not be recorded or alerted`);
  }
};
