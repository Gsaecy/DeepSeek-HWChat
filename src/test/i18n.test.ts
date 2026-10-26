import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  messageEntry,
  messageKeys,
  messageScriptTag,
  messageTable,
  normalizeLanguageSetting,
  resolveLanguage,
  t,
} from '../core/i18n';
import { env } from './support/vscodeMock';

/** 递归收集源文件，用于扫描 t() / tt() 的字面量键。 */
function collectFiles(root: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectFiles(full, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

const SOURCE_FILES = [
  ...collectFiles('src', ['.ts']).filter((file) => !file.includes(`${join('src', 'test')}`)),
  join('media', 'chat.js'),
  join('media', 'settings.js'),
];

test('中英两版键集合完全一致，且没有空文案', () => {
  const keys = messageKeys();
  assert.ok(keys.length > 200, `文案数量偏少：${keys.length}`);
  for (const key of keys) {
    const entry = messageEntry(key);
    assert.ok(entry, `缺少条目：${key}`);
    assert.ok(entry.zh.trim().length > 0, `中文文案为空：${key}`);
    assert.ok(entry.en.trim().length > 0, `英文文案为空：${key}`);
  }
});

test('中英两版必须真正不同（除专有名词外不能照抄）', () => {
  // 这些词在两种语言里写法相同，属于正常情况。
  const identicalAllowed = new Set([
    'language.en',
    'preset.autopilot.label',
    'settings.nav.agent',
    'settings.nav.skills',
    'settings.agent.title',
    'settings.skills.title',
    'settings.apiKey.label',
    'settings.apiKey.clearPlaceholder',
  ]);
  const identical = messageKeys().filter((key) => {
    const entry = messageEntry(key)!;
    return entry.zh === entry.en && !identicalAllowed.has(key);
  });
  assert.deepEqual(identical, [], `以下键中英完全相同，可能漏译：${identical.join(', ')}`);
});

test('源文件里引用的键都真实存在', () => {
  const known = new Set(messageKeys());
  const missing: string[] = [];
  for (const file of SOURCE_FILES) {
    const source = readFileSync(file, 'utf8');
    // 只匹配字面量调用：t('key' / tt('key'；带模板拼装的动态键不在此列。
    for (const match of source.matchAll(/\b(?:tt|t)\(\s*'([a-zA-Z][\w.]*)'/g)) {
      const key = match[1]!;
      if (!known.has(key)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `引用了不存在的文案键：\n${missing.join('\n')}`);
});

test('resolveLanguage：显式值与 auto 回落', () => {
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh');
  assert.equal(resolveLanguage('auto', 'zh-TW'), 'zh');
  assert.equal(resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveLanguage('auto', 'ja-JP'), 'en');
  // 非法值一律按 auto 处理，不能把未知字符串当成语言。
  assert.equal(resolveLanguage('fr', 'zh-CN'), 'zh');
  assert.equal(normalizeLanguageSetting(undefined), 'auto');
  assert.equal(normalizeLanguageSetting('custom'), 'auto');
});

test('t() 插值：替换占位符，缺值保留原样', () => {
  assert.equal(t('zh', 'chat.modelChanged', { model: 'v4' }), '已切换到 v4');
  assert.equal(t('en', 'chat.modelChanged', { model: 'v4' }), 'Switched to v4');
  assert.equal(t('en', 'chat.ready'), 'Ready');
  // 缺值时不吞掉占位符，便于定位调用方漏传参数。
  assert.equal(t('en', 'chat.modelChanged', {}), 'Switched to {model}');
  // 未知键返回键本身，界面上能直接看出漏译。
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
});

test('messageTable 覆盖全部键，并且与 t() 取值一致', () => {
  const zh = messageTable('zh');
  const en = messageTable('en');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of messageKeys()) {
    assert.equal(zh[key], t('zh', key));
    assert.equal(en[key], t('en', key));
  }
});

test('messageScriptTag 生成可安全嵌入的 JSON 块', () => {
  const tag = messageScriptTag('en', 'probe');
  assert.match(tag, /^<script type="application\/json" id="probe">/);
  assert.match(tag, /<\/script>$/);
  // 不能出现能提前闭合脚本块的裸尖括号。
  const json = tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>'));
  assert.ok(!json.includes('<'), '词表里出现了未转义的 <');
  assert.equal(JSON.parse(json)['chat.ready'], 'Ready');
});

test('跟随 VS Code 显示语言时，中文环境的文案是中文', () => {
  const original = env.language;
  try {
    env.language = 'zh-cn';
    assert.equal(resolveLanguage('auto', env.language), 'zh');
    env.language = 'en';
    assert.equal(resolveLanguage('auto', env.language), 'en');
  } finally {
    env.language = original;
  }
});
