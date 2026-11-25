import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { extractPreloads, inspectSubstack, normalizeTargetHost, safeFetchText } from '../src/index.mjs';

test('normalizes handles (including /@handle) and parses preloads-json cleanly', () => {
  assert.equal(normalizeTargetHost('aakashgupta'), 'aakashgupta.substack.com');
  assert.equal(normalizeTargetHost('@aakashgupta'), 'aakashgupta.substack.com');
  assert.equal(normalizeTargetHost('https://substack.com/@aakashgupta'), 'aakashgupta.substack.com');
  assert.equal(normalizeTargetHost('newsletter.pragmaticengineer.com'), 'newsletter.pragmaticengineer.com');
  const p = extractPreloads('<script id="preloads-json">{"pub":{"name":"Demo"}}</script>');
  assert.equal(p.pub.name, 'Demo');
});

test('handles zero-decimal currencies (JPY/KRW/VND), /feed sponsors, ARR floor, and SSRF/redirect/cap guards', async () => {
  assert.throws(() => normalizeTargetHost('http://127.0.0.1/about'));
  assert.throws(() => normalizeTargetHost('http://169.254.169.254/latest'));
  assert.throws(() => normalizeTargetHost('http://localhost:8080/about'));
  assert.throws(() => normalizeTargetHost('https://user:pass@aakashgupta.substack.com'));
  assert.throws(() => normalizeTargetHost('https://aakashgupta.substack.com:8443'));

  const ssrfRedir = await safeFetchText('https://aakashgupta.substack.com/about', {
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }),
  });
  assert.equal(ssrfRedir.ok, false);
  assert.equal(ssrfRedir.status, 400);

  const mockFetch = async (url) => {
    if (String(url).endsWith('/about')) {
      return new Response(
        `<script id="preloads-json">${JSON.stringify({
          pub: {
            name: 'Tokyo Brief',
            rankingDetail: 'Thousands of paid subscribers',
            plans: [
              { interval: 'year', amount: 12000, currency: 'jpy', active: true },
              { interval: 'year', amount: 50000, currency: 'krw', active: true },
              { interval: 'year', amount: 250000, currency: 'vnd', active: true },
            ],
          },
        })}</script>`,
        { status: 200 },
      );
    }
    if (String(url).endsWith('/feed')) {
      return new Response(
        `<rss><channel><item><title>Issue 1</title><link>https://tokyobrief.substack.com/p/1</link><content:encoded><![CDATA[Sponsored by <a href="https://workos.com/?utm_source=substack">WorkOS</a>]]></content:encoded></item></channel></rss>`,
        { status: 200 },
      );
    }
    return new Response('', { status: 404 });
  };

  const out = await inspectSubstack('https://substack.com/@tokyobrief', { fetchImpl: mockFetch });
  assert.equal(out.ok, true);
  assert.equal(out.plans[0].amount, 12000);
  assert.equal(out.plans[1].amount, 50000);
  assert.equal(out.plans[2].amount, 250000);
  assert.equal(out.bestsellerTier, 1000);
  assert.ok(out.verifiedPaidArrFloorUsd > 0);
  assert.equal(out.activeSponsors[0].domain, 'workos.com');

  let exitedNonZero = false;
  try {
    execFileSync(process.execPath, ['bin/cli.mjs', 'http://127.0.0.1/about'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    exitedNonZero = err.status === 1;
  }
  assert.equal(exitedNonZero, true);
});
