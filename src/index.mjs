const UA = 'Mozilla/5.0 (compatible; SubstackSponsorCheckerCLI/1.0)';

export function normalizeTargetHost(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || /[^a-z0-9.:/@_-]/.test(s)) throw new Error('Invalid Substack handle or domain');
  if (s.startsWith('@')) return s.slice(1) + '.substack.com';
  if (!s.includes('.')) return s + '.substack.com';
  const u = new URL(s.startsWith('http') ? s : 'https://' + s);
  return u.hostname.replace(/^www\./, '');
}

export function extractPreloads(html) {
  const idx = html.indexOf('id="preloads-json"');
  if (idx === -1) return null;
  const gt = html.indexOf('>', idx);
  const end = html.indexOf('</script>', gt + 1);
  if (gt === -1 || end === -1) return null;
  try { return JSON.parse(html.slice(gt + 1, end).trim()); } catch { return null; }
}

export async function inspectSubstack(rawInput, { fetchImpl = globalThis.fetch } = {}) {
  const host = normalizeTargetHost(rawInput);
  const res = await fetchImpl('https://' + host + '/about', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { ok: false, host, status: res.status };
  const html = await res.text();
  const pre = extractPreloads(html);
  const pub = pre?.pub || null;
  if (!pub) return { ok: false, host, error: 'preloads-json not found' };
  const plans = (pub.plans || []).filter((p) => p.active !== false).map((p) => ({
    interval: p.interval,
    amount: p.amount ? p.amount / 100 : null,
    currency: (p.currency || 'usd').toUpperCase(),
  }));
  return {
    ok: true,
    name: pub.name,
    host: pub.custom_domain || host,
    subscribers: pub.rankingDetailFreeSubscriberCount || pub.freeSubscriberCountOrderOfMagnitude || 'Public',
    bestsellerTier: pub.author_bestseller_tier || null,
    plans,
  };
}
