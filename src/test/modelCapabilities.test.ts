import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningEffortForModel, withFallbackCapabilities } from '../core/modelCapabilities';
import { ModelOption } from '../core/types';

/**
 * 「探到模型 ≠ 探到能力」。
 *
 * 真实故障：DeepSeek 的 `/models` 早先读不出思考档位（元数据在
 * `effort.supported_levels` 里），而 `modelOptionsForProfile()` 在发现成功后
 * **整体替换**内置表，于是 `reasoningSupport` 从 `configurable` 被洗成 `unknown`，
 * 工具条上的「思考深度」被灰成「能力未知」。这组用例锁住三种情况：
 * 探测缺失要补、探测有值要听它的、探测说「不支持」不许被内置值改回来。
 */

const official: ModelOption = {
  id: 'deepseek-flash',
  name: 'DeepSeek-V4.1-Flash',
  reasoningSupport: 'configurable',
  reasoningEfforts: ['none', 'low', 'high', 'max'],
};

test('探测结果 unknown 时用内置能力补齐（思考深度不再被灰掉）', () => {
  const merged = withFallbackCapabilities(
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoningSupport: 'unknown' },
    official,
  );
  assert.equal(merged.reasoningSupport, 'configurable');
  assert.deepEqual(merged.reasoningEfforts, ['none', 'low', 'high', 'max']);
});

test('探测到的能力优先于内置值', () => {
  const merged = withFallbackCapabilities(
    { id: 'deepseek-flash', name: 'x', reasoningSupport: 'configurable', reasoningEfforts: ['low', 'high', 'max'] },
    official,
  );
  assert.deepEqual(merged.reasoningEfforts, ['low', 'high', 'max'], '服务端真实档位不能被内置值覆盖');
});

test('探测明确说 unsupported 时不被内置值改回来', () => {
  const merged = withFallbackCapabilities(
    { id: 'deepseek-flash', name: 'x', reasoningSupport: 'unsupported' },
    official,
  );
  assert.equal(merged.reasoningSupport, 'unsupported');
});

test('探测说 fixed 时同样保留', () => {
  const merged = withFallbackCapabilities(
    { id: 'deepseek-flash', name: 'x', reasoningSupport: 'fixed', reasoningEfforts: ['high'] },
    official,
  );
  assert.equal(merged.reasoningSupport, 'fixed');
  assert.deepEqual(merged.reasoningEfforts, ['high']);
});

test('name 等于 id 时用内置显示名，不让下拉框退化成裸 id', () => {
  const merged = withFallbackCapabilities({ id: 'deepseek-flash', name: 'deepseek-flash' }, official);
  assert.equal(merged.name, 'DeepSeek-V4.1-Flash');
});

test('对端给了自己的显示名时以它为准', () => {
  const merged = withFallbackCapabilities({ id: 'deepseek-flash', name: 'Flash (custom)' }, official);
  assert.equal(merged.name, 'Flash (custom)');
});

test('没有内置条目时原样返回同一个对象', () => {
  const model: ModelOption = { id: 'other', name: 'other', reasoningSupport: 'unknown' };
  assert.equal(withFallbackCapabilities(model, undefined), model);
});

test('完全没变化时返回原对象，避免无意义的重建', () => {
  const same: ModelOption = {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    reasoningSupport: 'configurable',
    reasoningEfforts: official.reasoningEfforts,
  };
  assert.equal(withFallbackCapabilities(same, official), same);
});

/**
 * 档位校验的两条边界。
 *
 * 真实踩到过：DeepSeek 的 `effort.supported_levels` 按官方定义**不含 `none`**
 * （文档原话：`none`, which turns thinking mode off, is not included），
 * 于是「无」被当成非法值静默回落成「默认」——用户以为关掉了思考，
 * 实际仍在发 `thinking: enabled`，多烧 token。
 */
test('reasoningEffortForModel：声明列表不含 none 时，「无」仍然合法', () => {
  const deepseek = { ...official, reasoningEfforts: ['low', 'high', 'max'] as ModelOption['reasoningEfforts'] };
  assert.equal(reasoningEffortForModel('none', deepseek), 'none', '关闭思考必须真的能关');
  assert.equal(reasoningEffortForModel('low', deepseek), 'low');
  assert.equal(reasoningEffortForModel('high', deepseek), 'high');
  assert.equal(reasoningEffortForModel('max', deepseek), 'max');
});

test('reasoningEffortForModel：声明之外的档位回落成 default，不擅自改档', () => {
  const deepseek = { ...official, reasoningEfforts: ['low', 'high', 'max'] as ModelOption['reasoningEfforts'] };
  // medium 不在 DeepSeek 官方档位里 → 不替用户选 high，明确回到「模型官方默认」。
  assert.equal(reasoningEffortForModel('medium', deepseek), 'default');
});

test('reasoningEffortForModel：不支持 / 固定的模型一律回 default', () => {
  assert.equal(reasoningEffortForModel('high', { ...official, reasoningSupport: 'unsupported' }), 'default');
  assert.equal(reasoningEffortForModel('high', { ...official, reasoningSupport: 'fixed' }), 'default');
  assert.equal(reasoningEffortForModel('high', { ...official, reasoningSupport: 'unknown' }), 'default');
  assert.equal(reasoningEffortForModel('high', undefined), 'default');
});

test('reasoningEffortForModel：default 对任何模型都合法（不传参数）', () => {
  assert.equal(reasoningEffortForModel('default', undefined), 'default');
  assert.equal(reasoningEffortForModel('default', { ...official, reasoningSupport: 'unsupported' }), 'default');
});
