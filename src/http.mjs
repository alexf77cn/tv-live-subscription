import { lookup } from 'node:dns/promises';
import { allowedUrl, isPublicHost } from './merge.mjs';

export function createHttpClient(config, { fetchImpl = fetch, lookupImpl = lookup } = {}) {
  return async function read(url, { limit = 1024 * 1024, sample = false, deadline = Date.now() + config.timeoutMs } = {}) {
    let target = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!allowedUrl(target, config)) throw new Error('Blocked URL or placeholder redirect');
      const host = new URL(target).hostname.replace(/^\[|\]$/g, '');
      const addresses = await lookupImpl(host, { all: true });
      if (!addresses.length || addresses.some(item => !isPublicHost(item.address))) throw new Error('Non-public DNS destination');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Request deadline exceeded');
      const response = await fetchImpl(target, {
        redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, remaining)),
        headers: { 'User-Agent': 'TV-Source-Refresh/1.0', ...(sample ? { Range: `bytes=0-${limit - 1}` } : {}) },
      });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Redirect has no Location');
        target = new URL(location, target).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      if (!response.body) throw new Error('Empty response body');
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const room = limit - bytes;
          chunks.push(value.subarray(0, room));
          bytes += Math.min(value.length, room);
          if (bytes === limit) {
            await reader.cancel();
            if (!sample) throw new Error(`Response exceeded ${limit} bytes`);
            break;
          }
        }
      } finally { reader.releaseLock(); }
      if (!bytes) throw new Error('Empty response body');
      return { bytes: Buffer.concat(chunks, bytes), url: target, contentType: response.headers.get('content-type') ?? '' };
    }
    throw new Error('Too many redirects');
  };
}

export function looksLikeMedia(bytes, { allowMp4 = true } = {}) {
  const text = bytes.subarray(0, 512).toString('utf8').trimStart();
  if (/^<(?:!doctype|html|body)|no signal|not available|access denied/i.test(text)) return false;
  if (bytes.subarray(0, 3).toString('ascii') === 'FLV') return true;
  if (allowMp4 && ['ftyp','styp','moof'].includes(bytes.subarray(4, 8).toString('ascii'))) return true;
  for (let offset = 0; offset < Math.min(192, bytes.length); offset++) {
    if (bytes[offset] === 0x47 && (bytes[offset + 188] === 0x47 || bytes[offset + 192] === 0x47)) return true;
  }
  return false;
}

export function mediaPlaylist(text, baseUrl) {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean.startsWith('#EXTM3U') || /<\s*(?:!doctype|html|body)\b/i.test(clean.slice(0, 1024))) throw new Error('Not a real HLS playlist');
  if (/^#EXT-X-ENDLIST\s*$/m.test(clean) || /^#EXT-X-PLAYLIST-TYPE:VOD\s*$/m.test(clean)) throw new Error('Static recording/VOD playlist');
  if (/^#EXT-X-KEY:(?![^\r\n]*METHOD=NONE)/m.test(clean)) throw new Error('Encrypted segment cannot be verified by this lightweight check');
  const lines = clean.split(/\r?\n/).map(line => line.trim());
  const variants = [];
  const segments = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines.slice(index + 1).find(line => line && !line.startsWith('#'));
      if (next) variants.push(new URL(next, baseUrl).href);
    }
    if (lines[index].startsWith('#EXTINF:')) {
      const next = lines.slice(index + 1).find(line => line && !line.startsWith('#'));
      if (next) segments.push(new URL(next, baseUrl).href);
    }
  }
  if (!variants.length && !segments.length) throw new Error('Empty HLS playlist');
  return { variants, segments };
}

export function createProbe(config, read = createHttpClient(config)) {
  return async function probe(url) {
    const started = Date.now();
    const deadline = started + config.timeoutMs * 3;
    try {
      let target = url;
      for (let depth = 0; depth < 4; depth++) {
        // A prefix is enough to detect direct TS/FLV and avoids downloading an unbounded live stream.
        const response = await read(target, { limit: 512 * 1024, sample: true, deadline });
        if (looksLikeMedia(response.bytes, { allowMp4: false })) return { ok: true, type: 'direct-media', elapsedMs: Date.now() - started };
        const playlist = mediaPlaylist(response.bytes.toString('utf8'), response.url);
        if (playlist.variants.length) { target = playlist.variants[0]; continue; }
        const segment = await read(playlist.segments.at(-1), { limit: 4096, sample: true, deadline });
        if (!looksLikeMedia(segment.bytes)) throw new Error('Segment is not recognizable TS/MP4/FLV media');
        return { ok: true, type: 'hls-media', elapsedMs: Date.now() - started };
      }
      throw new Error('HLS nesting limit exceeded');
    } catch (error) { return { ok: false, reason: error.message, elapsedMs: Date.now() - started }; }
  };
}
