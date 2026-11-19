import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/api/openapi';

const document = buildOpenApiDocument();

type Operation = { security: { cognito: string[] }[] };

describe('OpenAPI document (docs/openapi.json)', () => {
  it('matches the committed file (regenerate with npm run openapi)', async () => {
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../docs/openapi.json');
  });

  it('documents exactly the routes and scopes that template.yaml deploys', () => {
    const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
    const deployed = [
      ...template.matchAll(
        /Method: (\w+)\s+Path: (\S+)\s+Auth:\s+Authorizer: \w+\s+AuthorizationScopes: \[([^\]]*)\]/g,
      ),
    ].map(([, method, path, scopes]) => `${method} ${path} [${scopes}]`);

    const documented = Object.entries(document.paths as Record<string, Record<string, Operation>>).flatMap(
      ([path, operations]) =>
        Object.entries(operations).map(
          ([method, operation]) => `${method.toUpperCase()} ${path} [${operation.security[0]!.cognito.join(', ')}]`,
        ),
    );

    expect(deployed).toHaveLength(5);
    expect(documented.sort()).toEqual(deployed.sort());
  });

  it('references only schemas it defines', () => {
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map(([, name]) => name);

    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((name) => !(name! in document.components.schemas))).toEqual([]);
  });
});
