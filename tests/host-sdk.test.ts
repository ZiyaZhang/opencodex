import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSdk } from '../src/host/sdk.js';
import { macOSHttpsProxy } from '../src/host/public-network.js';

test('SDK reads expose installed versions and bounded declaration slices without scanning unrelated packages', async () => {
  const result = await inspectSdk({ package: '@deepseek-ai/dsh-api-session-controller' });
  assert.equal(result.available, true); if (!result.available) throw new Error('Missing fixture SDK'); assert.equal(result.version, '0.2.1-alpha.2');
  assert.ok(result.content!.length <= 5000); assert.ok(result.sha256!.length === 64);
  assert.equal(result.path, 'lib/types/index.d.ts');
  const repeat = await inspectSdk({ package: '@deepseek-ai/dsh-api-session-controller', path: result.path, offset: 0 });
  if (!repeat.available) throw new Error('Missing fixture SDK'); assert.equal(repeat.sha256, result.sha256);
  await assert.rejects(inspectSdk({ package: 'unrelated-package' }), /Choose one/);
  await assert.rejects(inspectSdk({ package: '@deepseek-ai/dsh-api-session-controller', path: 'lib/../../secret.d.ts' }), /declaration path/);
  await assert.rejects(inspectSdk({ package: '@deepseek-ai/dsh-api-session-controller', offset: -1 }), /nonnegative/);
});

test('SDK links resolve TypeScript source-style imports to shipped declaration files', async () => {
  const result = await inspectSdk({ package: '@deepseek-ai/dsh-client-ui-conversation' });
  if (!result.available) throw new Error('Missing fixture SDK');
  assert.equal(result.path, 'lib/types/client/index.d.ts');
  assert.ok(result.related.includes('lib/types/client/contract/snapshot.d.ts'));
  const linked = await inspectSdk({ package: result.package, path: 'lib/types/client/contract/snapshot.d.ts' });
  assert.equal(linked.available, true);
});

test('system proxy parsing respects enablement and rejects malformed settings', () => {
  assert.equal(macOSHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'), 'http://127.0.0.1:7897');
  assert.equal(macOSHttpsProxy('HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'), undefined);
  assert.equal(macOSHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 8888'), 'http://[::1]:8888');
  assert.throws(() => macOSHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 999999'), /Invalid system/);
});
