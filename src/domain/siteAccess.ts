/**
 * Which sites a credential may send events for, or read.
 *
 * Each site's Cognito app client is granted a scope naming its location (washops/site.miami-01),
 * so the verified token itself carries the answer: no lookup on the request path. Without this
 * check, any valid site credential could post events, and revenue, for every other site.
 */

export const SITE_SCOPE_PREFIX = 'washops/site.';

export const siteScope = (locationId: string): string => `${SITE_SCOPE_PREFIX}${locationId}`;

export function canSendFor(scopes: readonly string[], locationId: string): boolean {
  return scopes.includes(siteScope(locationId));
}

/** The locations named by a token's site scopes, e.g. ['miami-01']. */
export function boundSites(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => scope.startsWith(SITE_SCOPE_PREFIX)).map((scope) => scope.slice(SITE_SCOPE_PREFIX.length));
}
