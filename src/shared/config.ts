/**
 * Resource names (bucket, queue URL, table names) are injected by the SAM template as
 * environment variables, so no account IDs, ARNs, or credentials live in the code.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
