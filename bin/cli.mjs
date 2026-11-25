#!/usr/bin/env node
import { inspectSubstack } from '../src/index.mjs';

const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log('Usage: substack-check <handle-or-domain>  (e.g. aakashgupta or newsletter.pragmaticengineer.com)');
  console.log('Free Web Tool: https://wonderpick.github.io/apify-b2b-ecom-automation-kit/tools/substack-sponsor-checker.html');
  process.exit(0);
}

try {
  const res = await inspectSubstack(arg);
  console.log(JSON.stringify(res, null, 2));
  if (!res?.ok) process.exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exitCode = 1;
}
