const UA = 'Mozilla/5.0 (compatible; SubstackSponsorCheckerCLI/1.1)';
const MAX_REDIRECTS = 5;
const MAX_ABOUT_BYTES = 400_000;
const MAX_FEED_BYTES = 250_000;
const SUBSTACK_TIMEOUT_MS = 10_000;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);
const BLOCKED_TLDS = ['.local', '.localhost', '.internal', '.lan', '.home', '.arpa', '.corp', '.metadata.goog'];

const ZERO_DECIMAL_CURRENCIES = new Set(['jpy', 'krw', 'vnd', 'clp', 'idr', 'twd']);
const FX_TO_USD = {
  usd: 1,
  eur: 1.08,
  gbp: 1.27,
  cad: 0.72,
  aud: 0.65,
  chf: 1.13,
  nzd: 0.59,
  sek: 0.095,
  nok: 0.092,
  dkk: 0.145,
  pln: 0.25,
  brl: 0.17,
  mxn: 0.05,
  inr: 0.012,
  sgd: 0.74,
  hkd: 0.128,
  jpy: 0.0066,
  krw: 0.00072,
  vnd: 0.000039,
};

const AD_MARKETPLACE_HOSTS = [
  { host: 'passionfroot.me', name: 'Passionfroot' },
  { host: 'passionfroot.xyz', name: 'Passionfroot' },
  { host: 'paved.com', name: 'Paved' },
  { host: 'swapstack.co', name: 'Swapstack' },
  { host: 'sponsy.com', name: 'Sponsy' },
  { host: 'sponsorgap.com', name: 'SponsorGap' },
  { host: 'sparkloop.app', name: 'SparkLoop' },
];

const NON_SPONSOR_HOSTS = new Set([
  'substack.com', 'substackcdn.com', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be',
  'github.com', 'linkedin.com', 'instagram.com', 'facebook.com', 'threads.net', 'bsky.app',
  'tiktok.com', 'spotify.com', 'apple.com', 'amazon.com', 'amzn.to', 'wikipedia.org',
  'reddit.com', 'medium.com', 'nytimes.com', 'wsj.com', 'bloomberg.com', 'ft.com',
  'reuters.com', 'theverge.com', 'techcrunch.com', 'arxiv.org', 'docs.google.com',
  'forms.gle', 'calendly.com', 'typeform.com', 'bit.ly', 't.co', 'goo.gl', 'vimeo.com',
  'notion.so', 'airtable.com', 'stripe.com', 'gumroad.com',
]);

const SPONSOR_CUE_RE = /(?:brought to you by|sponsored by|presented by|today['’]s sponsor|our sponsor|thanks to our sponsor|this (?:issue|edition|post|newsletter) is (?:brought to you|sponsored|presented|supported) by|in partnership with|a message from our sponsor|sponsor spotlight|partner spotlight|\(\s*sponsored?\s*\)|\[\s*sponsored?\s*\]|\bsponsored\s*(?:post|content|section|partner)\b)/i;

export function isBlockedHostnameOrIp(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const raw = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!raw) return true;
  if (/^\d+$/.test(raw) || /^0x[0-9a-f]+$/i.test(raw)) return true;
  if (/^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+)){1,3}$/i.test(raw)) return true;
  if (raw.includes(':')) return true;
  if (BLOCKED_HOSTNAMES.has(raw) || BLOCKED_TLDS.some((tld) => raw.endsWith(tld))) return true;
  return false;
}

export function validateSafeHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (u.username || u.password) {
    throw new Error('URLs with credentials are not allowed');
  }
  if (u.port && u.port !== '80' && u.port !== '443') {
    throw new Error('Non-standard URL ports are not allowed');
  }
  if (isBlockedHostnameOrIp(u.hostname)) {
    throw new Error(`Blocked internal/IP hostname (SSRF protection): ${u.hostname}`);
  }
  return u.toString();
}

async function readBoundedResponseText(res, maxBytes) {
  if (!res?.body) {
    const raw = typeof res?.text === 'function' ? await res.text() : '';
    const buf = Buffer.from(raw, 'utf8');
    if (buf.byteLength > maxBytes) {
      return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
    }
    return { text: raw, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const remain = maxBytes - total;
        if (remain > 0) {
          chunks.push(Buffer.from(value.subarray(0, remain)));
          total += remain;
        }
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated };
}

export async function safeFetchText(
  rawUrl,
  { fetchImpl = globalThis.fetch, headers = {}, timeoutMs = SUBSTACK_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, maxBytes = MAX_ABOUT_BYTES } = {},
) {
  let currentUrl;
  try {
    currentUrl = validateSafeHttpUrl(rawUrl);
  } catch (err) {
    return { ok: false, status: 400, error: err.message, text: '', truncated: false };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let res;
    try {
      res = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return {
        ok: false,
        status: timedOut ? 504 : 502,
        timedOut,
        error: timedOut ? 'Upstream request timed out' : err?.message || 'Network request failed',
        text: '',
        truncated: false,
      };
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers?.get?.('location') || '';
      await res.body?.cancel?.().catch(() => {});
      if (!loc) return { ok: false, status: res.status, error: 'Redirect missing Location header', text: '', truncated: false };
      try {
        currentUrl = validateSafeHttpUrl(new URL(loc, currentUrl).toString());
      } catch (err) {
        return { ok: false, status: 400, error: `Blocked redirect: ${err.message}`, text: '', truncated: false };
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, text: '', truncated: false };
    }

    const { text, truncated } = await readBoundedResponseText(res, maxBytes);
    return { ok: true, status: res.status, finalUrl: currentUrl, text, truncated };
  }
  return { ok: false, status: 502, error: `Too many redirects (>${maxRedirects})`, text: '', truncated: false };
}

export function normalizeTargetHost(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s.length > 260 || /[\u0000-\u001F<>`{}\\]/.test(s)) {
    throw new Error('Invalid Substack handle or domain');
  }
  if (s.startsWith('@')) {
    const handle = s.slice(1);
    if (!/^[a-z0-9_-]{1,64}$/.test(handle)) throw new Error('Invalid Substack @handle');
    return `${handle}.substack.com`;
  }
  if (!s.includes('.') && !s.includes('/')) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) throw new Error('Invalid Substack handle');
    return `${s}.substack.com`;
  }

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new Error('Invalid Substack URL or domain');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http/https URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Non-standard URL ports are not allowed');
  if (isBlockedHostnameOrIp(u.hostname)) throw new Error('Blocked internal/IP hostname (SSRF protection)');

  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  if (host === 'substack.com') {
    const m = u.pathname.match(/^\/@([a-z0-9_-]{1,64})/i);
    if (m) return `${m[1].toLowerCase()}.substack.com`;
    throw new Error('Use a publication URL (e.g. aakashgupta.substack.com) or /@handle');
  }
  if (!host.includes('.')) throw new Error('Invalid Substack domain');
  return host;
}

export function extractPreloads(html) {
  const idx = html.indexOf('id="preloads-json"');
  if (idx === -1) return null;
  const gt = html.indexOf('>', idx);
  const end = html.indexOf('</script>', gt + 1);
  if (gt === -1 || end === -1) return null;
  try { return JSON.parse(html.slice(gt + 1, end).trim()); } catch { return null; }
}

function normalizePlanAmount(rawAmount, currencyLower) {
  const n = Number(rawAmount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return ZERO_DECIMAL_CURRENCIES.has(currencyLower) ? n : Number((n / 100).toFixed(2));
}

function normalizePlanUsd(plan) {
  const usdUnit = plan?.currency_options?.usd?.unit_amount;
  if (Number.isFinite(usdUnit) && usdUnit > 0) return Number((usdUnit / 100).toFixed(2));
  const cur = String(plan?.currency || 'usd').toLowerCase();
  const amount = normalizePlanAmount(plan?.amount, cur);
  const rate = FX_TO_USD[cur];
  if (!amount || !Number.isFinite(rate)) return null;
  return Number((amount * rate).toFixed(2));
}

function parsePaidTierFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text.toLowerCase();
  if (/hundreds of thousands of paid/.test(t)) return 100_000;
  if (/tens of thousands of paid/.test(t)) return 10_000;
  if (/thousands of paid/.test(t)) return 1_000;
  if (/hundreds of paid/.test(t)) return 100;
  const m = t.match(/([\d,]+)\s*\+?\s*paid/);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function scanFeedForSponsors(xml, ownHost) {
  const cleanOwn = String(ownHost || '').toLowerCase().replace(/^www\./, '');
  const sponsors = new Map();
  const marketplaces = new Set();
  const recentPosts = [];
  let mediaKitUrl = null;
  let pos = 0;

  while (pos < xml.length && recentPosts.length < 5) {
    const start = xml.indexOf('<item>', pos);
    if (start === -1) break;
    const end = xml.indexOf('</item>', start + 6);
    if (end === -1) break;
    pos = end + 7;
    const block = xml.slice(start + 6, end);

    const getTag = (tag) => {
      const s = block.indexOf(`<${tag}`);
      if (s === -1) return '';
      const gt = block.indexOf('>', s);
      const e = gt !== -1 ? block.indexOf(`</${tag}>`, gt + 1) : -1;
      return gt !== -1 && e !== -1 ? block.slice(gt + 1, e) : '';
    };
    const title = getTag('title').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const link = getTag('link').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const body = getTag('content:encoded') || getTag('description');
    const plainBody = body.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const hasSponsorCue = SPONSOR_CUE_RE.test(plainBody);

    const bounded = body.slice(0, 45_000);
    const hrefRe = /href=["'](https?:\/\/[^"'<>\s]{4,350})["']/gi;
    let hm;
    let scanned = 0;
    while ((hm = hrefRe.exec(bounded)) !== null && scanned < 120) {
      scanned += 1;
      let parsed;
      try { parsed = new URL(hm[1]); } catch { continue; }
      const h = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const mp = AD_MARKETPLACE_HOSTS.find((m) => h === m.host || h.endsWith(`.${m.host}`));
      if (mp) {
        marketplaces.add(mp.name);
        if (!mediaKitUrl) mediaKitUrl = parsed.toString();
        continue;
      }
      if (h === cleanOwn || h.endsWith(`.${cleanOwn}`)) {
        if (!mediaKitUrl && /\/(?:sponsor|sponsors|advertise|media-kit)\b/i.test(parsed.pathname)) {
          mediaKitUrl = parsed.toString();
        }
        continue;
      }
      if (h.endsWith('.substack.com') || h.endsWith('.substackcdn.com')) continue;
      if ([...NON_SPONSOR_HOSTS].some((bad) => h === bad || h.endsWith(`.${bad}`))) continue;

      const nearby = bounded.slice(Math.max(0, hm.index - 320), Math.min(bounded.length, hm.index + 220));
      const utmMedium = (parsed.searchParams.get('utm_medium') || '').toLowerCase();
      const utmSource = (parsed.searchParams.get('utm_source') || '').toLowerCase();
      const isSponsorUtm = utmMedium.includes('sponsor') || utmMedium.includes('newsletter') || utmSource.includes('substack');
      if (SPONSOR_CUE_RE.test(nearby) || isSponsorUtm) {
        const entry = sponsors.get(h) || { domain: h, mentions: 0 };
        entry.mentions += 1;
        sponsors.set(h, entry);
      }
    }

    recentPosts.push({ title: title.slice(0, 140), url: /^https?:\/\//i.test(link) ? link : null, hasSponsorCue });
  }

  return {
    activeSponsors: [...sponsors.values()].sort((a, b) => b.mentions - a.mentions).slice(0, 10),
    adMarketplaces: [...marketplaces],
    mediaKitUrl,
    recentPosts,
  };
}

export async function inspectSubstack(rawInput, { fetchImpl = globalThis.fetch } = {}) {
  const host = normalizeTargetHost(rawInput);
  const aboutRes = await safeFetchText(`https://${host}/about`, {
    fetchImpl,
    headers: { 'User-Agent': UA },
    maxBytes: MAX_ABOUT_BYTES,
  });
  if (!aboutRes.ok) {
    return { ok: false, host, status: aboutRes.status, error: aboutRes.error };
  }

  const pre = extractPreloads(aboutRes.text);
  const pub = pre?.pub || null;
  if (!pub) return { ok: false, host, status: 404, error: 'preloads-json not found' };

  const activePlans = (pub.plans || []).filter((p) => p && p.active !== false);
  const plans = activePlans.map((p) => {
    const curLower = String(p.currency || 'usd').toLowerCase();
    return {
      interval: p.interval,
      amount: p.amount ? normalizePlanAmount(p.amount, curLower) : null,
      currency: curLower.toUpperCase(),
      usdAmount: normalizePlanUsd(p),
    };
  });

  const annualUsdList = activePlans
    .filter((p) => String(p.interval || '').toLowerCase() === 'year')
    .map((p) => normalizePlanUsd(p))
    .filter((n) => Number.isFinite(n) && n > 0);
  const monthlyUsdList = activePlans
    .filter((p) => String(p.interval || '').toLowerCase() === 'month')
    .map((p) => normalizePlanUsd(p))
    .filter((n) => Number.isFinite(n) && n > 0);
  const effectiveAnnualUsd = annualUsdList.length
    ? Math.min(...annualUsdList)
    : monthlyUsdList.length
      ? Number((Math.min(...monthlyUsdList) * 12).toFixed(2))
      : null;

  const rawTier = Number(pub.author_bestseller_tier ?? 0);
  const bestsellerTier = (Number.isFinite(rawTier) && rawTier > 0 ? rawTier : null) ?? parsePaidTierFromText(pub.rankingDetail);
  const verifiedPaidArrFloorUsd =
    bestsellerTier && effectiveAnnualUsd ? Math.round(bestsellerTier * effectiveAnnualUsd) : null;

  const resolvedHost = pub.custom_domain && !isBlockedHostnameOrIp(pub.custom_domain) ? pub.custom_domain : host;
  const feedRes = await safeFetchText(`https://${resolvedHost}/feed`, {
    fetchImpl,
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml;q=0.9' },
    maxBytes: MAX_FEED_BYTES,
  });
  const feedInfo = feedRes.ok
    ? scanFeedForSponsors(feedRes.text, resolvedHost)
    : { activeSponsors: [], adMarketplaces: [], mediaKitUrl: null, recentPosts: [] };

  return {
    ok: true,
    name: pub.name || resolvedHost,
    host: resolvedHost,
    subscribers: pub.rankingDetailFreeSubscriberCount || pub.freeSubscriberCountOrderOfMagnitude || 'Public',
    bestsellerTier: bestsellerTier || null,
    verifiedPaidArrFloorUsd,
    plans,
    ...feedInfo,
  };
}
