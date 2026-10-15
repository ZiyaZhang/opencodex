import test from 'node:test';
import assert from 'node:assert/strict';
import { macOSHttpsProxy } from '../src/host/public-network.ts';

test('system proxy parsing respects enablement and rejects malformed settings', () => {
  assert.equal(macOSHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'), 'http://127.0.0.1:7897');
  assert.equal(macOSHttpsProxy('HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897'), undefined);
  assert.equal(macOSHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 8888'), 'http://[::1]:8888');
  assert.throws(() => macOSHttpsProxy('HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 999999'), /Invalid system/);
});
