import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPreloads, normalizeTargetHost } from '../src/index.mjs';

test('normalizes handles and parses preloads-json cleanly', () => {
  assert.equal(normalizeTargetHost('aakashgupta'), 'aakashgupta.substack.com');
  assert.equal(normalizeTargetHost('newsletter.pragmaticengineer.com'), 'newsletter.pragmaticengineer.com');
  const p = extractPreloads('<script id="preloads-json">{"pub":{"name":"Demo"}}</script>');
  assert.equal(p.pub.name, 'Demo');
});
