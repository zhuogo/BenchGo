import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('cross-device OpenAPI references resolve and owner/device contracts stay separate', async () => {
  const spec = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
  const schemas = spec.components.schemas;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key], spec);
      assert.ok(target, `unresolved reference ${value.$ref}`);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(spec);
  const owner = spec.paths['/api/commander-devices'].post.requestBody.content['application/json'].schema.properties.action.enum;
  assert.deepEqual(owner, ['launch','devices','select','resources','resourceScope','setResourceScope']);
  const center = schemas.DeviceRequest.properties.action.enum;
  for (const action of ['devices','resources','resourceScope','setResourceScope','hostGrantDevice','hostManagementDecide']) assert.ok(center.includes(action));
  const directed = schemas.DirectedDeviceInput.properties.action.enum;
  assert.deepEqual(directed, ['state','models','create','history','send','cancel','respond','resources','collaboration','management']);
  for (const action of ['hostGrantDevice','hostManagementDecide','admin','configure','relay-pool-configure']) assert.equal(directed.includes(action), false);
  assert.equal(schemas.ResourcePage.properties.items.maxItems, 100);
  assert.equal(schemas.ResourceScope.additionalProperties, false);
  assert.deepEqual(schemas.ManagementOperation.properties.state.enum, ['pending','applying','applied','failed','unknown','expired','rejected','revoked']);
});
