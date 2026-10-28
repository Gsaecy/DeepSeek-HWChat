import type { ModelOption, ReasoningEffort } from './types';

/**
 * 「深度」档位的兜底列表（模型没声明 `reasoningEfforts` 时用）。
 *
 * `medium` 留着只是为了兼容旧存档与兼容接口：DeepSeek 官方档位是
 * low / high / max，`medium` 会被服务端折算成 `high`。
 */
export const REASONING_DEPTHS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

/**
 * 用「内置能力表」补齐「模型发现」拿到的条目。
 *
 * 真实故障：DeepSeek 的 `/models` 早期读不出思考档位（元数据一度只在
 * `effort.supported_levels` 里），而 `modelOptionsForProfile()` 在发现成功后
 * **整体替换**了内置表，于是 `reasoningSupport` 从 `configurable` 被洗成
 * `unknown`，工具条上的「思考深度」被灰成「能力未知」——而 DeepSeek 明明
 * 支持 `reasoning_effort`（Copilot 能设，HWChat 不能，就是这个差别）。
 *
 * 规则：**探测到的能力优先**（它更接近服务端真实状态）；
 * 探测没给出（`unknown` / 空数组）时才回落到内置值。
 */
export function withFallbackCapabilities(
  model: ModelOption,
  fallback: ModelOption | undefined,
): ModelOption {
  if (!fallback) return model;
  const reasoningSupport = model.reasoningSupport && model.reasoningSupport !== 'unknown'
    ? model.reasoningSupport
    : fallback.reasoningSupport;
  const reasoningEfforts = model.reasoningEfforts?.length
    ? model.reasoningEfforts
    : fallback.reasoningEfforts;
  // 探测结果里的 name 常常等于 id（对端没给 display_name），此时用内置显示名，
  // 否则模型下拉框会从「DeepSeek-V4.1-Flash」退化成裸 id。
  const name = model.name && model.name !== model.id ? model.name : fallback.name;
  if (
    reasoningSupport === model.reasoningSupport
    && reasoningEfforts === model.reasoningEfforts
    && name === model.name
  ) {
    return model;
  }
  return {
    ...model,
    name,
    reasoningSupport,
    reasoningEfforts: reasoningEfforts ? [...reasoningEfforts] : undefined,
  };
}

/**
 * 某个模型接不接受这个思考档位；不接受就回落到「模型官方默认」。
 *
 * 两条容易踩的边界：
 *  1. `default` 对任何模型都合法——它就是「不发参数、用模型官方默认」。
 *  2. `none`（关闭思考）**不看** `reasoningEfforts`：DeepSeek 的
 *     `effort.supported_levels` 按官方定义**不含 `none`**
 *     （文档原话：`none`, which turns thinking mode off, is not included），
 *     但 `reasoning_effort: "none"` 与 `thinking.type="disabled"` 都是合法请求。
 *     若按声明列表校验，用户选「无」会被静默改回「默认」，等于关不掉思考、多烧 token。
 */
export function reasoningEffortForModel(
  requested: ReasoningEffort,
  model: ModelOption | undefined,
): ReasoningEffort {
  if (requested === 'default') return 'default';
  if (model?.reasoningSupport !== 'configurable') return 'default';
  if (requested === 'none') return 'none';
  const allowed = model.reasoningEfforts?.length ? model.reasoningEfforts : REASONING_DEPTHS;
  return allowed.includes(requested) ? requested : 'default';
}
