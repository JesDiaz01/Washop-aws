/**
 * Site connectivity rules. A site is OFFLINE when its controller hasn't sent a heartbeat for longer
 * than the threshold. Only transitions matter: one alert when a site goes offline and one when it
 * comes back, never one per check.
 */

export type Connectivity = 'ONLINE' | 'OFFLINE';

export interface SiteHeartbeat {
  locationId: string;
  lastHeartbeat?: string;
  /** Absent until the site is first marked offline, which counts as ONLINE. */
  connectivity?: Connectivity;
}

export interface ReportingSite {
  locationId: string;
  lastHeartbeat: string;
}

export interface SiteAlert {
  subject: string;
  message: string;
}

const MINUTE_MS = 60_000;

export function minutesSince(timestamp: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(timestamp)) / MINUTE_MS);
}

/** The state a site should move to, or undefined if nothing changed. */
export function connectivityChangeFor(
  site: SiteHeartbeat,
  now: Date,
  offlineAfterMinutes: number,
): Connectivity | undefined {
  if (!site.lastHeartbeat) return undefined; // never reported: nothing to compare against

  const isSilent = now.getTime() - Date.parse(site.lastHeartbeat) > offlineAfterMinutes * MINUTE_MS;
  if (isSilent && site.connectivity !== 'OFFLINE') return 'OFFLINE';
  if (!isSilent && site.connectivity === 'OFFLINE') return 'ONLINE';
  return undefined;
}

export function siteAlertFor(site: ReportingSite, to: Connectivity, now: Date, offlineAfterMinutes: number): SiteAlert {
  if (to === 'OFFLINE') {
    return {
      subject: `WashOps: ${site.locationId} is offline`,
      message: [
        `Site ${site.locationId} has not sent a controller heartbeat for ${minutesSince(site.lastHeartbeat, now)} minutes.`,
        `Last heartbeat: ${site.lastHeartbeat} (alert threshold: ${offlineAfterMinutes} minutes).`,
        '',
        "Check the site's network connection and controller power. You will get another email when it is back online.",
      ].join('\n'),
    };
  }

  return {
    subject: `WashOps: ${site.locationId} is back online`,
    message: `Site ${site.locationId} is sending heartbeats again. Latest heartbeat: ${site.lastHeartbeat}.`,
  };
}
