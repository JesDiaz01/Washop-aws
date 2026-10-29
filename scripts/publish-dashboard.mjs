#!/usr/bin/env node
/**
 * Uploads the dashboard (dashboard/) to its S3 bucket, with a config.json built from the stack's
 * outputs, so the page knows which API and sign-in endpoints to use.
 *
 * Usage: node scripts/publish-dashboard.mjs [stackName]
 *
 * Uses the AWS CLI, so it runs with whatever credentials the CLI has (e.g. after `aws login`).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stackName = process.argv[2] ?? 'washops';
const aws = (...args) => execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const outputs = Object.fromEntries(
  JSON.parse(aws('cloudformation', 'describe-stacks', '--stack-name', stackName, '--query', 'Stacks[0].Outputs', '--output', 'json')).map(
    ({ OutputKey, OutputValue }) => [OutputKey, OutputValue],
  ),
);

const required = ['ApiBaseUrl', 'AuthDomain', 'DashboardClientId', 'DashboardBucketName', 'DashboardUrl'];
const missing = required.filter((key) => !outputs[key]);
if (missing.length) {
  console.error(`Stack ${stackName} is missing outputs: ${missing.join(', ')}. Deploy the latest template first.`);
  process.exit(1);
}

const bucket = `s3://${outputs.DashboardBucketName}`;
const configDir = mkdtempSync(join(tmpdir(), 'washops-dashboard-'));
const configFile = join(configDir, 'config.json');
writeFileSync(
  configFile,
  JSON.stringify({ apiBaseUrl: outputs.ApiBaseUrl, authDomain: outputs.AuthDomain, clientId: outputs.DashboardClientId }, null, 2),
);

// Short cache lifetimes: CloudFront picks up a new upload within a minute, no invalidation needed.
console.log(`Uploading dashboard/ to ${bucket}`);
aws('s3', 'sync', 'dashboard/', `${bucket}/`, '--delete', '--exclude', 'config.json', '--cache-control', 'max-age=60');
aws('s3', 'cp', configFile, `${bucket}/config.json`, '--content-type', 'application/json', '--cache-control', 'no-cache');

console.log(`\nDashboard published: ${outputs.DashboardUrl}`);
console.log('Invite a user (Cognito emails a temporary password):');
console.log(
  `  aws cognito-idp admin-create-user --user-pool-id ${outputs.UserPoolId ?? '<UserPoolId>'} --username you@example.com --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true`,
);
