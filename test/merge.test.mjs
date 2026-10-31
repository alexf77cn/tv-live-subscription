import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allowedUrl, canonicalName, mergeChannels, parseM3u, validateOutput } from '../src/merge.mjs';
import { createProbe, createHttpClient, mediaPlaylist } from '../src/http.mjs';
import { runUpdate } from '../src/update.mjs';

const config = {
  sources: [{ name: 'a', url: 'https://a.example/list.m3u' }, { name: 'b', url: 'https://b.example/list.m3u' }],
  timeoutMs: 1000, concurrency: 2, maxProbesPerChannel: 6, newUrisPerChannel: 2, maxUrisPerChannel: 6,
  requiredChannels: ['CCTV-1', 'CCTV-5', 'CCTV-5+'],
  blockedHosts: ['bad.example'], blockedUrls: ['https://liveplay-srs.voc.com.cn/hls/tv/134_180adf.m3u8'],
};
const ch = (name, group = '央视') => ({ group, name, title: name, uris: [`https://seed.example/${encodeURIComponent(name)}.m3u8`] });
const seed = [ch('CCTV-1'), ch('CCTV-5'), ch('CCTV-5+'), ch('浙江卫视', '卫视'), { group: '香港', name: '凤凰中文', title: '凤凰中文', uris: ['http://127.0.0.1:34567/fh/phoenix.flv'], extra: { preserved: true } }];
const list = rows => '#EXTM3U\n' + rows.map(([name,url]) => `#EXTINF:-1,${name}\n${url}\n`).join('');
const goodList = list([['CCTV1综合HD', 'https://fresh.example/cctv1.m3u8'], ['CCTV5体育', 'https://fresh.example/cctv5.m3u8'], ['CCTV5+体育赛事', 'https://fresh.example/cctv5p.m3u8']]);
const passed = async () => ({ ok: true, type: 'hls-media' });

test('HTML and empty M3U are rejected instead of replacing the channel table', () => {
  assert.throws(() => parseM3u('<!DOCTYPE html><html>error</html>'));
  assert.throws(() => parseM3u('#EXTM3U\n'));
  assert.throws(() => mediaPlaylist('#EXTM3U\n', 'https://x.example/live.m3u8'));
});

test('known bad streams stay blocked when upstream appends an IPTV line label', () => {
  const bad = 'https://liveplay-srs.voc.com.cn/hls/tv/134_180adf.m3u8';
  assert.equal(allowedUrl(bad + '$IPV4•线路2', config), false);
  assert.equal(allowedUrl(bad + '$IPV6•线路17', config), false);
  assert.equal(allowedUrl('https://fresh.example/live.m3u8$IPV4•线路2', config), true);
  assert.equal(allowedUrl('http://bad.example:9901/live/cctv2.m3u8', config), false);
});

test('CCTV-5 and 5+ aliases stay distinct; unknown program suffixes do not become channels', () => {
  assert.equal(canonicalName('CCTV5体育 HD'), 'CCTV-5');
  assert.equal(canonicalName('CCTV-5+ 体育赛事 FHD'), 'CCTV-5+');
  assert.equal(canonicalName('CCTV5PLUS'), 'CCTV-5+');
  assert.notEqual(canonicalName('CCTV-1电视剧'), 'CCTV-1');
  assert.notEqual(canonicalName('CCTV-4欧洲'), 'CCTV-4');
  assert.notEqual(canonicalName('CCTV-5节目广告'), 'CCTV-5');
});

test('single-source failure can replace a failed first choice without losing previous known URLs', async () => {
  const previous = structuredClone(seed);
  previous[0].uris.unshift('https://previous.example/cctv1.m3u8');
  const result = await mergeChannels({ seed, previous, config, loadSource: async url => { if (url.includes('a.example')) throw new Error('unavailable'); return goodList; }, probe: async url => ({ ok: !url.includes('previous.example') }) });
  assert.equal(result.report.sources.filter(source => source.ok).length, 1);
  assert.equal(result.channels[0].uris[0], 'https://fresh.example/cctv1.m3u8');
  assert(result.channels[0].uris.includes('https://previous.example/cctv1.m3u8'));
  assert(result.channels[0].uris.includes(seed[0].uris[0]));
});

test('a healthy current URL listed seventh upstream remains first without expanding the probe budget', async () => {
  const current = 'https://previous.example/cctv1.m3u8';
  const previous = structuredClone(seed);
  previous[0].uris.unshift(current);
  const longList = list([
    ...Array.from({ length: 6 }, (_, index) => ['CCTV1', `https://candidate.example/cctv1-${index}.m3u8`]),
    ['CCTV1', current],
  ]);
  const result = await mergeChannels({ seed, previous, config, loadSource: async url => url.includes('a.example') ? longList : goodList, probe: passed });
  assert.equal(result.channels[0].uris[0], current);
  assert.equal(result.report.channels[0].keptCurrentFirst, true);
  assert.equal(result.report.channels[0].candidateCount, config.maxProbesPerChannel);
  assert.equal(result.report.probes.filter(row => row.name === 'CCTV-1').length, config.maxProbesPerChannel);
});

test('one unavailable source does not imply that a healthy non-seed current URL was removed', async () => {
  const current = 'https://previous.example/cctv1.m3u8';
  const previous = structuredClone(seed);
  previous[0].uris.unshift(current);
  const result = await mergeChannels({ seed, previous, config, loadSource: async url => {
    if (url.includes('a.example')) throw new Error('source temporarily unavailable');
    return goodList;
  }, probe: passed });
  assert.equal(result.report.sources.filter(source => source.ok).length, 1);
  assert.equal(result.channels[0].uris[0], current);
  assert.equal(result.report.channels[0].keptCurrentFirst, true);
  assert(result.channels[0].uris.includes('https://fresh.example/cctv1.m3u8'));
});

test('regional objects, including nested metadata and Phoenix loopback, remain byte-equivalent objects', async () => {
  const text = goodList + '#EXTINF:-1,凤凰中文\nhttps://fake.example/phoenix.m3u8\n';
  const result = await mergeChannels({ seed, config, loadSource: async () => text, probe: passed });
  assert.deepEqual(result.channels.at(-1), seed.at(-1));
  assert.equal(result.channels.length, seed.length);
  assert.deepEqual(result.channels.map(c => c.name), seed.map(c => c.name));
});

test('healthy manual first choice stays first while fresh upstream backups are refreshed', async () => {
  const result = await mergeChannels({ seed, config, loadSource: async () => goodList, probe: passed });
  assert.equal(result.channels[0].uris[0], seed[0].uris[0]);
  assert(result.channels[0].uris.includes('https://fresh.example/cctv1.m3u8'));
  assert.equal(result.report.channels[0].keptCurrentFirst, true);
});

test('failed first choice promotes a validated new upstream and keeps the manual fallback', async () => {
  const result = await mergeChannels({ seed, config, loadSource: async () => goodList, probe: async url => ({ ok: !url.includes('seed.example') }) });
  assert.equal(result.channels[0].uris[0], 'https://fresh.example/cctv1.m3u8');
  assert(result.channels[0].uris.includes(seed[0].uris[0]));
  assert.equal(result.report.channels[0].currentFirstPassed, false);
});

test('upstream removal and failed media checks retain the previous channel and every seed fallback', async () => {
  const previous = structuredClone(seed);
  previous[2].uris.unshift('https://previous.example/sports.m3u8');
  const result = await mergeChannels({ seed, previous, config, loadSource: async () => list([['CCTV1', 'https://fresh.example/cctv1.m3u8']]), probe: async () => ({ ok: false, reason: 'HTTP 403' }) });
  assert.deepEqual(result.channels[2], previous[2]);
  assert.deepEqual(result.channels[3], seed[3]);
  assert.throws(() => validateOutput(result.channels.slice(1), seed, config), /count/);
  const changed = structuredClone(result.channels); changed.at(-1).name = 'Something else';
  assert.throws(() => validateOutput(changed, seed, config), /Protected/);
});

test('all-source failure leaves the published files exactly untouched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tv-subscription-test-'));
  await mkdir(path.join(root, 'config')); await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'config/sources.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'config/seed-channels.json'), JSON.stringify(seed));
  const original = JSON.stringify(seed, null, 3);
  await writeFile(path.join(root, 'docs/channels.json'), original);
  await writeFile(path.join(root, 'docs/report.json'), '{"unchanged":true}');
  await assert.rejects(runUpdate(root, { loadSource: async () => '<html>Unavailable</html>', probe: passed }), /All upstream/);
  assert.equal(await readFile(path.join(root, 'docs/channels.json'), 'utf8'), original);
  assert.equal(await readFile(path.join(root, 'docs/report.json'), 'utf8'), '{"unchanged":true}');
});

test('known wrong channel, private destinations and temporary signatures cannot be published', () => {
  for (const url of ['https://liveplay-srs.voc.com.cn/hls/tv/134_180adf.m3u8', 'http://10.2.3.4/live', 'http://127.0.0.1/live', 'http://169.254.169.254/latest', 'https://bad.example/live', 'https://x.example/nosignal_h264/playlist.m3u8', 'https://x.example/live?txSecret=a&txTime=b', 'https://x.example/live?u=admin&p=secret']) assert.equal(allowedUrl(url, config, { stable: true }), false, url);
  assert.equal(allowedUrl('https://x.example/live?key=txiptv', config, { stable: true }), true);
});

test('probe rejects HTML disguised as HLS, HTML media segments and finite recordings', async () => {
  const bodies = {
    'https://x.example/bad.m3u8': '<html>not a stream</html>',
    'https://x.example/live.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nsegment.ts\n',
    'https://x.example/segment.ts': '<html>permission denied</html>',
    'https://x.example/vod.m3u8': '#EXTM3U\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n',
  };
  const probe = createProbe(config, async url => ({ bytes: Buffer.from(bodies[url]), url }));
  for (const url of ['bad.m3u8','live.m3u8','vod.m3u8']) assert.equal((await probe(`https://x.example/${url}`)).ok, false);
});

test('probe follows a relative master and requires recognizable media bytes', async () => {
  const ts = Buffer.alloc(600); ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
  const bodies = {
    'https://x.example/master.m3u8': Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlow/live.m3u8\n'),
    'https://x.example/low/live.m3u8': Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\na.ts\n'),
    'https://x.example/low/a.ts': ts,
  };
  const probe = createProbe(config, async url => ({ bytes: bodies[url], url }));
  assert.equal((await probe('https://x.example/master.m3u8')).ok, true);
});

test('a static MP4 file cannot bypass HLS live-playlist validation', async () => {
  const fakeMp4 = Buffer.alloc(32); fakeMp4.write('ftyp', 4);
  const probe = createProbe(config, async url => ({ bytes: fakeMp4, url }));
  assert.equal((await probe('https://x.example/old-recording.mp4')).ok, false);
});

test('HTTP redirects to known placeholders or private addresses are blocked before a second fetch', async () => {
  let fetches = 0;
  const read = createHttpClient(config, {
    lookupImpl: async () => [{ address: '8.8.8.8' }],
    fetchImpl: async () => { fetches++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); },
  });
  await assert.rejects(read('https://x.example/live'), /Blocked/);
  assert.equal(fetches, 1);
});
