# 网关层 LLM 输出稳定性策略

> **创建日期**：2026-05-07
> **背景**：与 ts-lab session 讨论 LLM 输出稳定性时引出的架构判断。本文锁定 llm-platform 在「LLM 输出稳定性」这个问题上的边界与分阶段计划，避免下次重新拍板。

---

## 问题陈述

LLM 调用的下游消费者经常需要稳定的结构化输出（JSON / Function Calling 参数）。常见失败模式：

- JSON 不合法（markdown 包裹 / 尾逗号 / 单引号 / 字段缺失）
- 输出截断（`finish_reason=length`）
- 字段类型漂移
- 模型自由发挥（输出含解释文本而非纯 JSON）

**问题**：llm-platform 作为推理网关，是否应主动解决这些？

---

## 三层架构选项

| Layer | 定位 | llm-platform 当前状态 |
|---|---|---|
| **A. 透传层** | 客户端在请求体里塞 `extra_body.guided_json` / `tools` / `response_format`，网关原样转发 | ✅ 应已支持（OpenAI 兼容代理 default 行为），**未实测覆盖** |
| **B. 网关增强层** | 客户端打开开关 / 加自定义字段，网关自动注入 schema、retry on parse fail、fallback parse | ❌ 未做。**有人提议过，本文判断「晚一步做 / 做也最小化」** |
| **C. 库层 SDK** | llm-platform 发布客户端 SDK，里面包 robust_parser + 自动 guided_json 配置 | ❌ 未做，无计划 |

---

## 分层取舍详解

### Layer A — 必做的最小集

**原理**：LLM 输出稳定性的根本解法是 **vLLM 服务器侧约束解码**（`extra_body.guided_json` / `tools` / `response_format`）。约束解码在生成层 logits mask，从源头杜绝非法输出。

**网关只需保证透传完整，不需要做任何额外事情**：

```
客户端                      llm-platform              vLLM
  │                              │                     │
  │ POST /v1/chat/completions    │                     │
  │   { messages,                │                     │
  │     extra_body: {            │                     │
  │       guided_json: SCHEMA }} │                     │
  ├──────────────────────────────►                     │
  │                              ├─────────────────────►
  │                              │           (vLLM 在生成层
  │                              │            约束 token 概率)
  │                              ◄─────────────────────┤
  │       绝对合法 JSON          │                     │
  ◄──────────────────────────────┤                     │
  │                              │                     │
客户端 json.loads 不会失败       网关只透传，不参与
```

**透传必须覆盖的 4 类字段**（写集成测试逐一验证）：

1. `tools` / `tool_choice`（OpenAI Function Calling 标准）
2. `response_format: {type: "json_schema", strict: true}`（OpenAI Structured Output）
3. `extra_body.guided_json` / `guided_regex` / `guided_choice`（vLLM 原生约束解码）
4. `n` / `temperature` / `seed`（多次采样需要，self_consistency 类技术依赖）

**动作**：写 `backend/tests/test_passthrough.py`，对每类字段验证：
- 客户端发送时字段进入 vLLM 请求体（中间不丢）
- vLLM 响应原样返回（中间不重写）

**优先级**：🔴 高 —— 是网关基本职责，应当作 OpenAI 兼容性的一部分对待。

### Layer B — 晚一步做，做也要最小化

**有人会问**："网关帮客户端自动加 guided_json，统一治理，多好"。

**风险评估**：

| 风险 | 说明 |
|---|---|
| 破坏 OpenAI 兼容性 | 加自定义字段（`X-LLMP-Stability`）的客户端无法换其他 OpenAI 兼容网关 |
| 状态化代理 | 网关从「无状态转发」变成「有状态业务逻辑」，复杂度上一个台阶 |
| 流式响应难处理 | 如果网关要在响应侧解析 / fallback / retry，SSE chunked 流式响应处理急剧复杂化 |
| 没有用户证据 | `chat_logs` 里有人在塞 `guided_json` 吗？如果 0 个真用户，给谁开关？ |

**判断标准（按 llm-platform 工程原则）**：

> "Don't add features, refactor, or introduce abstractions beyond what the task requires. Don't design for hypothetical future requirements."

**结论**：当前不做。

**真要做时的最小实现原则 — only inject, never parse**：

```yaml
请求方:
  POST /v1/chat/completions
  X-LLMP-Auto-Schema: anomaly-v1   ← 网关识别 schema 名
  body: { messages: [...] }         ← 不含 extra_body

网关:
  1. 查 X-LLMP-Auto-Schema 对应的 schema 定义（白名单字典）
  2. 自动注入 extra_body.guided_json
  3. 转发给 vLLM
  4. 响应原样返回（不解析、不重写、不 retry）

响应方:
  收到约束保证的合法 JSON，自己 json.loads
```

**关键克制点**（违反任一就重新审视方案）：

- ❌ **不在网关内嵌 robust_parser** —— 那是客户端的事。网关解析响应 = 状态化 = 流式难做
- ❌ **不做 retry on parse fail** —— 那是客户端的事。约束解码失败本身就是边缘事件，网关不替客户端做决定
- ❌ **不内嵌任何 ts-lab technique 代码** —— ts-lab 是 lab 阶段，沉淀路径走 ts-platform RC-10，不直接进网关
- ✅ **只做 schema 中心化管理 + 自动注入** —— 网关仍是无状态代理，只是多了一张 schema 白名单

### Layer C — 永远不做

**为什么**：
- llm-platform 维护 SDK = 与每种语言生态绑定（Python/JS/Go/...）
- 客户端 robust_parser 50 行的事，给每个客户端发包不划算
- ts-lab 如果未来抽 robust_parser 包，那是 ts-lab 的事，llm-platform 直接复用即可

---

## 分阶段计划

### 阶段 1（**本周可做**）— 验证 Layer A

**目标**：确认网关默认透传完整。

**任务**：
- [ ] 写 `backend/tests/test_passthrough.py`
  - [ ] `extra_body.guided_json` 透传
  - [ ] `tools` / `tool_choice` 透传
  - [ ] `response_format` 透传
  - [ ] `n` / `seed` 透传
- [ ] 在 `frontend/src/pages/ApiDocs/ApiDocs.tsx` 加这三类透传的使用示例（让用户知道网关支持）
- [ ] 如果发现某字段被 `services/api.ts` 的 snake↔camel 转换破坏，修

**预期输出**：一份「llm-platform 透传完整性报告」，列出每类字段的实测结果。

### 阶段 2（**ts-lab benchmark 出结果后**）— 数据驱动决策

**触发条件**：ts-lab `guided_json` technique 完成 + 在 50-sample pilot 上跑出对比数据。

**决策点**：
- 若 guided_json 把解析失败率从 ~5% 打到 <0.1% → llm-platform 增加 ApiDocs 文档教用户怎么用 → **Layer A 已够，不做 Layer B**
- 若用户反馈「自己写 schema 麻烦，能否网关帮我加默认 schema」 → 才做 Layer B 最小版

### 阶段 3（**仅在阶段 2 触发后**）— Layer B 最小实现

**前提**：阶段 2 出现真实用户需求。

**实现范围**：仅做 schema 自动注入，遵循「only inject, never parse」原则。

**实现规模估计**：
- 后端：~50 行（schema 白名单 + 请求 middleware）
- 前端：ApiDocs 页加文档（无 UI 改动）
- 测试：~30 行

**反复审视的问题**：
- 这个 schema 注入功能能不能用 `extra_body` 透传 + 客户端配置库实现？如果能，仍然不做 Layer B
- 加这个开关后，OpenAI 兼容性测试是否仍 100% 通过？

---

## 与 ts-lab 的边界

ts-lab 与 llm-platform 在 LLM 输出稳定性上有重叠关注，但各自定位不同：

| 维度 | ts-lab | llm-platform |
|---|---|---|
| 核心问题 | 时序异常检测 Qwen-VL → JSON 解析的稳定性 + 准确性 | 通用 LLM 网关的请求路由 + 透传 |
| 解决手段 | 7 件套（事前约束 + 事后兜底 + 多次投票 + 二次审查） | 透传 + 监控 + 限流 |
| 域绑定 | 强（异常区间、IoU、chart rendering） | 无（model-agnostic） |
| 沉淀路径 | RC-10 流程沉到 **ts-platform** 生产代码 | 自身就是生产代码，不再下沉 |

**关键判断**：

- ts-lab 的 `robust_parser` / `guided_json` 即使做完也**不下沉到 llm-platform** —— 它们沉到 ts-platform（异常检测推理 pipeline）
- llm-platform 不 import ts-lab 任何代码
- 双方共享的是**工程方法论**（[`engineering-principles.md`](engineering-principles.md) 7 条），不是代码

---

## 历史

- 2026-05-07 创建本文档；同日讨论 ts-lab 7 件套 / Function Calling / 约束解码与 llm-platform 复用边界后沉淀
- 关联讨论：[../../ts-lab/TODO.md](../../ts-lab/TODO.md) §技术路线讨论补遗（2026-05-07）
