import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseDocument, isMap, isSeq } from 'yaml';
import { atomicWrite, pruneBackups } from './sync.js';

// DSH（DeepSeek Harness）侧没有 models.json 这种“一整份模型清单”的文件：
// 模型来源是 profile 里 cordis.patch.yml 的 llm-pi-ai 插件配置。
// 它的 patch 语义是“按 id 整段替换 config”，所以必须把 provider 合并进
// 已有的那一条，绝不能追加第二条 llm-pi-ai——那会把用户的其它 provider 整段顶掉。
export const PROVIDER_ID = 'oc-ferry';
export const ENTRY_ID = 'llm-pi-ai';
const ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai';
const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`;

const positive = value => Number.isInteger(value) && value > 0 ? value : null;

// dsh 的模型条目只需要“怎么连、能吃多少”：
// 上下文与输出上限取 OpenCode 目录里声明的值，没声明就用 dsh 自己的默认。
export function dshModelEntry(model) {
  const contextWindow = positive(model.context) ?? positive(model.input) ?? 262144;
  const maxTokens = positive(model.output) ?? 32768;
  return {
    id: model.id,
    // DSH 没有“按模型关工具”的开关；只回文本的模型在名字上标出来，
    // 免得用户在 DSH 里对着一堆工具调用失败猜原因。
    name: `OC · ${model.name}${model.chatOnly === true ? '（仅对话）' : ''}`,
    input: model.images === true ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens,
  };
}

export function dshProvider(models, endpoint, key) {
  return {
    displayName: 'OC Ferry',
    api: 'openai-completions',
    baseURL: endpoint.replace(/\/+$/, ''),
    // 本机转发口要 Bearer 口令；dsh 认这里的 Authorization 头，
    // 这样口令只留在这份我们自己维护的配置里，不碰 ~/.dsh/.credentials.yaml。
    headers: { Authorization: `Bearer ${key}` },
    models: models.map(dshModelEntry),
  };
}

export function locateDshHome({ env = process.env, home = os.homedir() } = {}) {
  const configured = env.DSH_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(home, '.dsh');
}

// 只认有 package.json 的目录：profiles 下还有 node_modules 这种同名干扰项。
export async function listDshProfiles(home = locateDshHome()) {
  const directory = path.join(home, 'profiles');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directoryPath = path.join(directory, entry.name);
    const manifest = await fs.stat(path.join(directoryPath, 'package.json')).catch(() => null);
    if (!manifest?.isFile()) continue;
    profiles.push({ name: entry.name, patchFile: path.join(directoryPath, 'cordis.patch.yml') });
  }
  return profiles;
}

function entryMap(document) {
  const seq = document.contents;
  if (!isSeq(seq)) return null;
  return seq.items.find(item => isMap(item) && item.get('id') === ENTRY_ID) ?? null;
}

// provider 为 null 表示“摘掉自己的条目”。只删自己的 oc-ferry 键，
// 用户写的其它 provider 一律原样保留；摘完变空的容器才顺手收掉。
function removeProvider(document) {
  const entry = entryMap(document);
  if (!entry) return document;
  const config = entry.get('config');
  const providers = isMap(config) ? config.get('providers') : null;
  if (!isMap(providers) || !providers.has(PROVIDER_ID)) return document;
  providers.delete(PROVIDER_ID);
  if (providers.items.length === 0) config.delete('providers');
  if (isMap(config) && config.items.length === 0) entry.delete('config');
  if (entry.items.length <= 2 && !entry.has('config')) {
    const seq = document.contents;
    const index = seq.items.indexOf(entry);
    if (index >= 0) seq.items.splice(index, 1);
  }
  return document;
}

function addProvider(document, provider) {
  let entry = entryMap(document);
  if (!entry) {
    // `[]` 与空文档都按块状风格补：默认的流式写法（`[ { … } ]`）人能读但没人愿意维护。
    if (!isSeq(document.contents)) document.contents = document.createNode([], { flow: false });
    else if (document.contents.items.length === 0) document.contents.flow = false;
    entry = document.createNode({ id: ENTRY_ID, name: ENTRY_NAME, config: { providers: {} } }, { flow: false });
    document.contents.items.push(entry);
  }
  const config = isMap(entry.get('config')) ? entry.get('config') : entry.set('config', {});
  const providers = isMap(config.get('providers')) ? config.get('providers') : config.set('providers', {});
  providers.set(PROVIDER_ID, provider);
  return document;
}

// 纯文本进、纯文本出：解析用 yaml 的文档模型（保留注释与既有排版），
// 空文件、只有注释、`[]` 三种起步形态都能收敛到同一个结构。
export function renderPatch(text, provider) {
  const source = text?.trim() ? text : PATCH_HEADER + '[]\n';
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length) throw new Error(`DSH 配置不是可解析的 YAML：${document.errors[0].message}`);
  const next = provider === null ? removeProvider(document) : addProvider(document, provider);
  // 不按 80 列折行：Bearer 口令被折成两行虽然 YAML 解析等价，
  // 但人看一眼会以为配置坏了，也容易被别的工具按行处理坏。
  return next.toString({ lineWidth: 0 });
}

export function providerSummary(provider) {
  return provider?.models?.length ?? 0;
}

// 写入所有 DSH profile。models 为空 = 收摊，只摘自己的条目。
// 与 WorkBuddy 的 syncModels 保持同一套规矩：内容相同不写、写前备份、原子替换。
export async function syncDshProvider(profiles, models, endpoint, key, { allowEmpty = false } = {}) {
  if (!profiles.length) throw new Error('未检测到 DSH profile；请先启动一次 DeepSeek Harness（~/.dsh/profiles）');
  if (!models.length && !allowEmpty) throw new Error('Empty model discovery; existing DSH configuration preserved');
  const provider = models.length ? dshProvider(models, endpoint, key) : null;
  let changed = false;
  const touched = [];
  for (const profile of profiles) {
    const old = await fs.readFile(profile.patchFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (old === null && provider === null) continue;
    let next;
    try { next = renderPatch(old ?? '', provider); }
    catch (error) { throw new Error(`${profile.name}：${error.message}`); }
    if (next === (old ?? '')) continue;
    const current = await fs.readFile(profile.patchFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current !== old) throw new Error(`${profile.name} 的 DSH 配置在写入过程中被修改，请重试`);
    if (old !== null) {
      const backup = `${profile.patchFile}.oc-ferry-${Date.now()}.bak`;
      await fs.writeFile(backup, old, { mode: 0o600, flag: 'wx' });
      await pruneBackups(profile.patchFile);
    }
    await atomicWrite(profile.patchFile, next);
    changed = true;
    touched.push(profile.name);
  }
  return { changed, count: providerSummary(provider), profiles: touched, target: 'dsh' };
}
