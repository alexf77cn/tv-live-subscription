import { isDeepStrictEqual } from 'node:util';

export const mainlandGroups = new Set(['央视', '卫视']);
const transientKeys = /^(?:txsecret|txtime|wssecret|wstime|(?:access_|refresh_)?token|expires?|expiry|timestamp|sign(?:ature)?|auth_?key|api_?key|password|passwd|pwd|authorization|credential|hdnts)$/i;
const placeholderPath = /(?:no[-_]?signal|download[-_]?app|maintenance|notfound|\/offline(?:\/|\.|$))/i;
const unique = values => [...new Set(values)];

export function canonicalName(value) {
  let name = String(value).normalize('NFKC').trim().toUpperCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/\b(?:IPV[46]|FHD|UHD|SD|HEVC|H\.26[45]|\d{3,4}P)\b/g, '')
    .replace(/(?:高清|超清|标清|蓝光|频道|頻道|测试|测试源)/g, '')
    .replace(/衛視/g, '卫视').replace(/\s+/g, '')
    .replace(/(?:HD|4K|8K)$/g, '');
  const cctv = name.match(/^(?:CCTV|央视|中央)[-_]?(\d{1,2})(\+|PLUS|P)?(.*)$/);
  if (cctv) {
    const key = `${Number(cctv[1])}${cctv[2] ? '+' : ''}`;
    const suffixes = {
      '1': ['综合'], '2': ['财经'], '3': ['综艺'], '4': ['中文国际', '中文国际亚洲', '亚洲'],
      '5': ['体育'], '5+': ['体育赛事', '赛事'], '6': ['电影'], '7': ['国防军事', '军事农业'],
      '8': ['电视剧'], '9': ['纪录', '记录'], '10': ['科教'], '11': ['戏曲'], '12': ['社会与法'],
      '13': ['新闻'], '14': ['少儿'], '15': ['音乐'], '16': ['奥林匹克'], '17': ['农业农村', '农业'],
    };
    if (!cctv[3] || suffixes[key]?.includes(cctv[3])) return `CCTV-${key}`;
  }
  const aliases = { '上海卫视': '东方卫视', '内蒙卫视': '内蒙古卫视', '新疆兵团卫视': '兵团卫视' };
  return aliases[name] ?? name;
}

export function isPublicHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a,b] = h.split('.').map(Number);
    return !([0,10,127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1' || /^(?:f[cd]|fe[89ab]|ff)/.test(h)) return false;
    if (h.startsWith('::ffff:')) return false;
  }
  return true;
}

export function allowedUrl(value, config, { stable = false } = {}) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isPublicHost(url.hostname)) return false;
    if (config.blockedUrls?.includes(url.href) || config.blockedUrls?.includes(value)) return false;
    if (config.blockedHosts?.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return false;
    if (placeholderPath.test(url.pathname)) return false;
    if (stable && [...url.searchParams.keys()].some(key => transientKeys.test(key))) return false;
    if (stable && url.searchParams.has('u') && url.searchParams.has('p')) return false;
    return true;
  } catch { return false; }
}

export function parseM3u(text) {
  const clean = String(text).replace(/^\uFEFF/, '').trim();
  if (!clean.startsWith('#EXTM3U') || /<\s*(?:!doctype|html|body)\b/i.test(clean.slice(0, 1024))) throw new Error('Source is not an M3U channel list');
  const entries = [];
  let name = null, requiresHeaders = false;
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/^#EXTINF:.*?,(.*)$/);
      name = match?.[1]?.trim() ?? null;
      requiresHeaders = false;
    } else if (/^#(?:EXTVLCOPT|KODIPROP):/i.test(line)) {
      // Do not claim a URL-only MYTV entry works when an upstream requires custom headers or DRM.
      requiresHeaders = true;
    } else if (line && !line.startsWith('#')) {
      if (name && !requiresHeaders && /^https?:\/\//i.test(line) && !/[|\s]/.test(line)) entries.push({ name, url: line });
      name = null;
    }
  }
  if (!entries.length) throw new Error('Source contains no usable URL-only channels');
  return entries;
}

export function validateSeed(seed, config) {
  if (!Array.isArray(seed) || !seed.length) throw new Error('Seed is empty');
  const keys = new Set();
  for (const ch of seed) {
    const key = `${ch.group}/${ch.name}`;
    if (!ch.group || !ch.name || !Array.isArray(ch.uris) || !ch.uris.length || ch.uris.some(uri => typeof uri !== 'string' || !uri)) throw new Error(`Invalid seed channel ${key}`);
    if (keys.has(key)) throw new Error(`Duplicate seed channel ${key}`);
    keys.add(key);
    if (mainlandGroups.has(ch.group) && ch.uris.some(uri => !allowedUrl(uri, config, { stable: true }))) throw new Error(`Unsafe or transient seed URL: ${key}`);
  }
  for (const name of config.requiredChannels ?? []) if (!seed.some(ch => ch.group === '央视' && ch.name === name)) throw new Error(`Required seed channel missing: ${name}`);
}

export function validateOutput(output, seed, config) {
  validateSeed(seed, config);
  if (!Array.isArray(output) || output.length !== seed.length) throw new Error('Channel count changed; refusing to publish');
  output.forEach((ch, index) => {
    const old = seed[index];
    if (!mainlandGroups.has(old.group)) {
      if (!isDeepStrictEqual(ch, old)) throw new Error(`Protected regional channel changed: ${old.name}`);
      return;
    }
    if (!isDeepStrictEqual({ ...ch, uris: [] }, { ...old, uris: [] })) throw new Error(`Channel identity/order changed: ${old.name}`);
    if (!Array.isArray(ch.uris) || !ch.uris.length || ch.uris.length > config.maxUrisPerChannel || unique(ch.uris).length !== ch.uris.length) throw new Error(`Invalid URL count: ${ch.name}`);
    if (ch.uris.some(uri => !allowedUrl(uri, config, { stable: true }))) throw new Error(`Invalid publish URL: ${ch.name}`);
    if (old.uris.some(uri => !ch.uris.includes(uri))) throw new Error(`Verified fallback removed: ${ch.name}`);
  });
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; output[index] = await fn(items[index], index); }
  }));
  return output;
}

export async function mergeChannels({ seed, previous = seed, config, loadSource, probe, now = () => new Date().toISOString() }) {
  validateSeed(seed, config);
  validateOutput(previous, seed, config);
  const targets = seed.filter(ch => mainlandGroups.has(ch.group));
  const whitelist = new Map(targets.map(ch => [canonicalName(ch.name), ch.name]));
  const sources = await Promise.all(config.sources.map(async source => {
    try {
      const parsed = parseM3u(await loadSource(source.url));
      const entries = parsed.filter(row => whitelist.has(canonicalName(row.name)) && allowedUrl(row.url, config, { stable: true }));
      if (!entries.length) throw new Error('No allowlisted stable channels');
      return { name: source.name, url: source.url, ok: true, entries };
    } catch (error) { return { name: source.name, url: source.url, ok: false, error: error.message, entries: [] }; }
  }));
  if (!sources.some(source => source.ok)) throw new Error('All upstream sources failed; existing published files are unchanged');
  const hasSourceFailure = sources.some(source => !source.ok);
  const jobs = [];
  const candidates = new Map();
  const upstreamUrls = new Map();
  for (const ch of targets) {
    const bySource = sources.filter(source => source.ok).map(source => unique(source.entries.filter(row => whitelist.get(canonicalName(row.name)) === ch.name).map(row => row.url)));
    // Membership must use the complete upstream lists, independently of the probe budget.
    upstreamUrls.set(ch.name, new Set(bySource.flat()));
    const roundRobin = [];
    for (let index = 0; index < config.maxProbesPerChannel; index++) for (const urls of bySource) if (urls[index]) roundRobin.push(urls[index]);
    // Probe new candidates before the seed, because the existing URLs remain as fallbacks regardless.
    const all = unique(roundRobin);
    const current = previous[seed.indexOf(ch)].uris[0];
    const picked = unique([current, ...all.filter(url => !ch.uris.includes(url)), ...all.filter(url => ch.uris.includes(url))]).slice(0, config.maxProbesPerChannel);
    candidates.set(ch.name, picked);
    for (const url of picked) jobs.push({ name: ch.name, url });
  }
  const results = await mapLimit(jobs, config.concurrency, async job => {
    try { return { ...job, ...(await probe(job.url)) }; }
    catch (error) { return { ...job, ok: false, reason: error.message }; }
  });
  const reportChannels = [];
  const output = seed.map((ch, index) => {
    if (!mainlandGroups.has(ch.group)) return structuredClone(ch);
    const good = results.filter(row => row.name === ch.name && row.ok).map(row => row.url);
    const current = previous[index].uris[0];
    const currentPassed = good.includes(current);
    // A missing/failed source cannot provide evidence that a healthy current URL was removed.
    const keepCurrentFirst = currentPassed && (hasSourceFailure || upstreamUrls.get(ch.name).has(current) || ch.uris.includes(current));
    const goodUpstream = good.filter(url => upstreamUrls.get(ch.name).has(url));
    const next = goodUpstream.filter(url => !keepCurrentFirst || url !== current).slice(0, config.newUrisPerChannel);
    let uris;
    if (keepCurrentFirst || next.length) uris = unique([...(keepCurrentFirst ? [current] : []), ...next, ...ch.uris, ...previous[index].uris]);
    else uris = unique([...previous[index].uris, ...ch.uris]);
    // Seed fallbacks are mandatory. If limits cannot hold them, fail rather than silently drop one.
    if (ch.uris.length > config.maxUrisPerChannel) throw new Error(`Too many required fallbacks: ${ch.name}`);
    if (uris.length > config.maxUrisPerChannel) {
      let optionalCount = 0;
      const optionalBudget = config.maxUrisPerChannel - ch.uris.length;
      uris = uris.filter(url => ch.uris.includes(url) || optionalCount++ < optionalBudget);
    }
    reportChannels.push({ name: ch.name, candidateCount: candidates.get(ch.name).length, passed: good, currentFirstPassed: currentPassed, keptCurrentFirst: keepCurrentFirst, selected: uris, keptPrevious: !keepCurrentFirst && !next.length });
    return { ...structuredClone(ch), uris };
  });
  validateOutput(output, seed, config);
  return {
    channels: output,
    report: {
      generatedAt: now(), timezone: 'UTC', channelCount: output.length,
      protectedChannelCount: seed.length - targets.length,
      automaticValidation: 'HTTP/HLS structure and first media bytes only; no automatic logo, program identity, playlist-progress or long-duration playback verification. A healthy current/seed first choice stays first; new candidates replace failed/removed choices and refresh backups.',
      sources: sources.map(({ entries, ...source }) => ({ ...source, candidateCount: entries.length })),
      channels: reportChannels, probes: results,
    },
  };
}
