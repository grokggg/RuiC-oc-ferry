import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderPatch, dshProvider, dshModelEntry, syncDshProvider, listDshProfiles, PROVIDER_ID } from '../src/dsh-config.js';

const PATCH = `# 用户自己的注释保留
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: true
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      deepseek-v4.1:
        displayName: DeepSeek V4.1
        api: openai-completions
        baseURL: https://api.deepseek.com
        models:
          - id: deepseek-flash
            name: DeepSeek V4.1 Flash
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    models: []
`;
const FREE = [{ id: 'opencode/space-bunny-free', name: 'space bunny free', images: true, context: 1048576, output: 524288, chatOnly: false }];

test('写入 provider：只新增自己的块，其他 provider 与注释原样保留', () => {
  const text = renderPatch(PATCH, dshProvider(FREE, 'http://127.0.0.1:41980/v1', 'k-1'));
  assert.match(text, /# 用户自己的注释保留/);
  assert.match(text, /deepseek-v4\.1:/);
  assert.match(text, /oc-ferry:/);
  assert.match(text, /Authorization: Bearer k-1\n/);
  // 不能出现第二条 llm-pi-ai：patch 按 id 整段替换 config，会顶掉别的 provider。
  assert.equal(text.match(/- id: llm-pi-ai/g).length, 1);
});

test('摘除 provider 后回到原文（内容级）', () => {
  const added = renderPatch(PATCH, dshProvider(FREE, 'http://127.0.0.1:41980/v1', 'k-1'));
  const removed = renderPatch(added, null);
  assert.equal(removed, PATCH);
});

test('model 条目按目录声明换算，仅对话模型也能落地', () => {
  const entry = dshModelEntry({ id: 'opencode/x', name: 'X', images: false, context: 200000, output: 32000 });
  assert.deepEqual(entry, { id: 'opencode/x', name: 'OC · X', input: ['text'], contextWindow: 200000, maxTokens: 32000 });
  const bare = dshModelEntry({ id: 'opencode/y', name: 'Y' });
  assert.equal(bare.contextWindow, 262144);
  assert.equal(bare.maxTokens, 32768);
  assert.equal(dshModelEntry({ id: 'opencode/z', name: 'Z', chatOnly: true }).name, 'OC · Z（仅对话）');
});

test('从空 patch 起步也能建出结构', () => {
  const text = renderPatch('', dshProvider(FREE, 'http://127.0.0.1:41980/v1', 'k'));
  assert.match(text, /- id: llm-pi-ai/);
  assert.match(text, /baseURL: http:\/\/127\.0\.0\.1:41980\/v1/);
  assert.equal(renderPatch(text, null).includes(PROVIDER_ID), false);
});

test('无法解析的配置直接报错而不是覆盖', () => {
  assert.throws(() => renderPatch('- id: [unclosed', dshProvider(FREE, 'http://x', 'k')), /YAML/);
});

test('syncDshProvider：写入、幂等、备份、退出清理', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-dsh-'));
  const profile = path.join(home, 'profiles', 'desktop');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), PATCH);
  await fs.writeFile(path.join(profile, 'package.json'), '{"name":"p"}');
  const profiles = await listDshProfiles(home);
  assert.deepEqual(profiles.map(p => p.name), ['desktop']);

  const first = await syncDshProvider(profiles, FREE, 'http://127.0.0.1:41980/v1', 'k-1');
  assert.equal(first.changed, true);
  assert.equal(first.count, 1);
  const backups = (await fs.readdir(profile)).filter(name => name.includes('.oc-ferry-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);

  const second = await syncDshProvider(profiles, FREE, 'http://127.0.0.1:41980/v1', 'k-1');
  assert.equal(second.changed, false);

  const cleaned = await syncDshProvider(profiles, [], 'http://127.0.0.1:41980/v1', 'k-1', { allowEmpty: true });
  assert.equal(cleaned.changed, true);
  const final = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
  assert.equal(final, PATCH);
  assert.equal(final.includes(PROVIDER_ID), false);
  await fs.rm(home, { recursive: true, force: true });
});

test('listDshProfiles 跳过 node_modules 之类的非 profile 目录', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-dsh-list-'));
  await fs.mkdir(path.join(home, 'profiles', 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(home, 'profiles', 'web'), { recursive: true });
  await fs.writeFile(path.join(home, 'profiles', 'web', 'package.json'), '{}');
  assert.deepEqual((await listDshProfiles(home)).map(p => p.name), ['web']);
  await fs.rm(home, { recursive: true, force: true });
});
