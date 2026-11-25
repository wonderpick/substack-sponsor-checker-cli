#!/usr/bin/env node
import { inspectSubstack } from '../src/index.mjs';
const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log('Usage: substack-check <handle-or-domain>  (e.g. aakashgupta or newsletter.pragmaticengineer.com)');
  console.log('Free Web Tool: https://wonderpick.github.io/apify-b2b-ecom-automation-kit/tools/substack-sponsor-checker.html');
  process.exit(0);
}
console.log(JSON.stringify(await inspectSubstack(arg), null, 2));
