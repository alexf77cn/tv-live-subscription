import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeChannels } from './merge.mjs';
import { createHttpClient, createProbe } from './http.mjs';

const json = text => JSON.parse(text.replace(/^\uFEFF/, ''));

export async function runUpdate(root, dependencies = {}) {
  const config = json(await readFile(path.join(root, 'config/sources.json'), 'utf8'));
  const seed = json(await readFile(path.join(root, 'config/seed-channels.json'), 'utf8'));
  let previous;
  try { previous = json(await readFile(path.join(root, 'docs/channels.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; previous = seed; }
  const read = createHttpClient(config);
  const result = await mergeChannels({
    config, seed, previous,
    loadSource: dependencies.loadSource ?? (async url => (await read(url, { limit: 8 * 1024 * 1024, deadline: Date.now() + 20000 })).bytes.toString('utf8')),
    probe: dependencies.probe ?? createProbe(config, read),
    now: dependencies.now,
  });
  // Nothing is written until every merge invariant has passed. Workflow deploy runs only on exit 0.
  await mkdir(path.join(root, 'docs'), { recursive: true });
  for (const [name, body] of [['channels.json', result.channels], ['report.json', result.report]]) {
    const target = path.join(root, 'docs', name);
    const temp = `${target}.next`;
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = await runUpdate(root);
    console.log(JSON.stringify({ channels: result.channels.length, regionalPreserved: result.report.protectedChannelCount, successfulSources: result.report.sources.filter(source => source.ok).length, channelsWithValidatedUpstream: result.report.channels.filter(channel => channel.passed.length).length }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
