import { execFileSync } from 'node:child_process';

/**
 * Everything the integration tests need to call a deployed WashOps stack, read from the stack
 * itself with the AWS CLI (outputs, plus the demo site's client secret). Set WASHOPS_STACK to
 * choose the stack (default washops-dev), or set the four WASHOPS_* values directly.
 */

export interface StackConfig {
  stackName: string;
  apiBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface SiteToken {
  accessToken: string;
  scopes: string[];
  /** The location this credential may send events for (from its washops/site.* scope). */
  locationId: string;
}

const aws = (...args: string[]) => execFileSync('aws', args, { encoding: 'utf8' }).trim();

export function loadStackConfig(): StackConfig {
  const env = process.env;
  const stackName = env.WASHOPS_STACK ?? 'washops-dev';

  if (env.WASHOPS_API_URL && env.WASHOPS_TOKEN_URL && env.WASHOPS_CLIENT_ID && env.WASHOPS_CLIENT_SECRET) {
    return {
      stackName,
      apiBaseUrl: env.WASHOPS_API_URL,
      tokenUrl: env.WASHOPS_TOKEN_URL,
      clientId: env.WASHOPS_CLIENT_ID,
      clientSecret: env.WASHOPS_CLIENT_SECRET,
    };
  }

  let outputs: Record<string, string>;
  try {
    const raw = aws('cloudformation', 'describe-stacks', '--stack-name', stackName, '--query', 'Stacks[0].Outputs', '--output', 'json');
    outputs = Object.fromEntries(
      (JSON.parse(raw) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]),
    );
  } catch (error) {
    throw new Error(
      `Could not read stack ${stackName} with the AWS CLI. Deploy it first (sam deploy), sign in (aws login), ` +
        'or set WASHOPS_API_URL, WASHOPS_TOKEN_URL, WASHOPS_CLIENT_ID and WASHOPS_CLIENT_SECRET.',
      { cause: error },
    );
  }

  const required = ['ApiBaseUrl', 'TokenUrl', 'UserPoolId', 'SiteControllerClientId'];
  const missing = required.filter((key) => !outputs[key]);
  if (missing.length > 0) throw new Error(`Stack ${stackName} is missing outputs: ${missing.join(', ')}`);

  const clientSecret = aws(
    'cognito-idp', 'describe-user-pool-client',
    '--user-pool-id', outputs.UserPoolId!,
    '--client-id', outputs.SiteControllerClientId!,
    '--query', 'UserPoolClient.ClientSecret', '--output', 'text',
  );

  return {
    stackName,
    apiBaseUrl: outputs.ApiBaseUrl!.replace(/\/$/, ''),
    tokenUrl: outputs.TokenUrl!,
    clientId: outputs.SiteControllerClientId!,
    clientSecret,
  };
}

/** Client credentials grant. No scope parameter: Cognito grants every scope the client is allowed. */
export async function getSiteToken(config: StackConfig): Promise<SiteToken> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!response.ok) throw new Error(`Token request failed: ${response.status} ${await response.text()}`);

  const { access_token: accessToken } = (await response.json()) as { access_token: string };
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as { scope?: string };
  const scopes = claims.scope?.split(' ') ?? [];
  const siteScope = scopes.find((scope) => scope.startsWith('washops/site.'));
  if (!siteScope) throw new Error(`The test credential has no washops/site.* scope (scopes: ${scopes.join(', ')})`);

  return { accessToken, scopes, locationId: siteScope.slice('washops/site.'.length) };
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function callApi(
  config: StackConfig,
  method: 'GET' | 'POST',
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Processing is asynchronous: poll until `check` returns a value, or fail after the timeout. */
export async function eventually<T>(
  description: string,
  check: () => Promise<T | undefined>,
  { timeoutMs = 30_000, intervalMs = 1_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
