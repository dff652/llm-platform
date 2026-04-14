# 设计决策记录

> 记录开发过程中的关键问题讨论、方案选择和解决思路。

---

## DD-001: 新建项目 vs 在 ts-platform 上改造

**背景**: 需要基于 ts-platform（时序数据分析平台）构建 LLM 推理网关。

**方案对比**:
- **A. 在 ts-platform 上加模块**: 零成本复用基础设施，但两个业务域耦合
- **B. 全新独立项目**: 干净设计，但重建认证/用户/模型/GPU/队列，工作量大
- **C. Fork 改造**: 复制基础设施，剥离时序代码，保留通用能力

**决策**: 方案 C — Fork ts-platform，删除时序专用代码（algorithms/、pipeline、anomaly detection），保留通用基础设施（auth、API Key、model store、GPU 管理、Redis/Celery、Docker）。

**结果**: 项目 1 天可运行，复用了 ~60% 的基础设施代码。

---

## DD-002: OpenAI 兼容 API 设计 — 代理透传 vs 自建推理

**背景**: LLM 推理网关的核心 API 如何设计？

**方案**:
- **自建推理**: 平台内加载模型、执行推理 — 太重，和 vLLM 功能重复
- **代理透传**: 接收 OpenAI 格式请求 → 认证/路由 → 转发到 vLLM → 透传响应

**决策**: 代理透传。平台不做推理计算，只做认证、路由、日志、管理。

**关键实现**:
- `/v1/` 前缀的 OpenAI API 和 `/api/v1/` 前缀的管理 API 分离
- 流式响应：检测 content-type，SSE 流原样转发，非 SSE 后端包装为 `data:` 格式
- httpx.AsyncClient 单例复用（/simplify 审查发现每次请求都创建新客户端的 P0 bug）

---

## DD-003: 模型服务 vs 模型注册 — 是否合并

**背景**: ts-platform 有 InferenceService（引擎）和 ModelEntity（模型）两个独立实体。LLM 平台是否需要分开？

**讨论过程**:
1. 初始设计：两个独立页面（模型注册 + 模型服务）
2. 用户反馈：操作割裂，要先注册模型再创建服务，不合理
3. 讨论：同一个模型可能部署多个实例（不同 GPU/端口/量化） → 一对多关系 → 不应合并
4. 最终方案：**不合并实体，但合并操作入口**

**决策**:
- ModelEntity 保留（模型元数据），但不再有独立页面
- 模型注册内容合并到模型商店"已发布"标签页（只读展示）
- 所有操作集中在"模型服务"页面（唯一操作入口）
- 服务创建时可选择已注册模型自动填充字段

**参考**: ts-platform 的引擎管理页也是唯一操作入口，一页搞定所有配置。

---

## DD-004: 进程管理 — systemd 检测

**背景**: ChatTS 和 Qwen 服务通过 systemd user service 运行（`Restart=always`），平台 kill 进程后 systemd 10 秒内自动重启。

**问题**: 平台的 stop 只用 `kill` 终止进程，但 systemd 会自动重启，导致"停止不了"。

**解决方案**: stop 接口自动检测进程是否由 systemd 管理:
1. `lsof -ti :port` 找到 PID
2. `systemctl --user status <PID>` 检查是否有对应 systemd unit
3. 有 → `systemctl --user stop <unit>`（正确停止，不会重启）
4. 无 → `kill` 进程（平台自己启动的进程）

**反思**: systemd 检测是兼容历史环境的权宜之计。正确做法是由平台统一管理进程生命周期，不应有"外部启动的进程"混合状态。后续都通过平台启停后可简化此逻辑。

---

## DD-005: 负载均衡 — round-robin 实现

**背景**: 同一个模型可能有多个 vLLM 实例（不同 GPU），需要请求分发。

**设计参考**: ts-platform 的 `ServiceService.resolve_for_algorithm` — round-robin + 健康过滤。

**实现**:
1. `resolve_endpoint(model, db)` 查询所有 `model_name=model` 且 `status=enabled` 的服务
2. 单实例：直接返回，无开销
3. 多实例：并发健康检查（`GET /v1/models`，30s 缓存），过滤不可达实例
4. 在健康实例间 round-robin 轮询（模块级计数器 `_rr_counter`）
5. 所有实例不可达时回退到第一个（让 ensure_running 尝试拉起）

**局限**: 当前是内存级 round-robin，多 worker 进程间不共享计数器。生产环境可改用 Redis 原子计数器。

---

## DD-006: 服务表单交互 — 参考 ts-platform ServiceForm

**背景**: 原项目 ServiceForm 有完善的联动逻辑，当前项目表单是简单的静态表单。

**借鉴的交互**:
- 选择已注册模型 → 自动填充 name、displayName、modelPath、modelName、endpoint、execCommand
- GPU 设备下拉选择 → 自动设置 tensor-parallel-size（选 `0,1` 双卡 → tp=2）
- 修改任何 GPU 参数 → 实时重建 exec_command（不需要点"生成"按钮）
- 修改端口 → 实时更新 endpoint
- 多卡模式自动加 `--disable-custom-all-reduce --enforce-eager`
- GPU 设备自动写入 `CUDA_VISIBLE_DEVICES` 环境变量
- 连接测试按钮：直接 fetch endpoint/v1/models

**新增**:
- "从已注册模型创建"下拉框（ts-platform 也有类似功能）
- 从模型注册页"部署服务"按钮跳转时自动预选模型（URL 参数传递 `?create=1&modelId=X`）

---

## DD-007: 卡片布局 vs 表格布局

**背景**: 模型服务页最初是表格布局，信息密度高但操作空间紧凑。

**分析**:
- GPU 服务数量通常 2-8 个，不是几百条记录
- 每个服务有多种状态（健康、进程、启用/禁用）和多种操作（启停、编辑、日志、删除）
- 表格行里放这么多按钮很拥挤

**决策**: 改为卡片布局（参考 ts-platform 引擎管理页）。每张卡片显示：
- 健康状态圆点（绿/蓝脉冲/红/灰）
- GPU Badge
- 端点、模型名、PID
- 状态提示文字
- 底部操作区：左侧启停按钮，右侧开关 + 工具按钮

---

## DD-008: 模型商店页面结构优化

**背景**: 模型注册页（ModelCenter）作为独立页面功能单薄 — 只有只读展示和删除。

**讨论**: 模型注册的数据来源只有模型商店发布。独立页面意义不大。

**决策**: 合并到模型商店，作为第三个标签页"已发布"。用户在一个页面完成完整流程：
```
模型浏览 → 下载管理 → 已发布
  搜索/下载   进度/重试   查看已发布模型 + 部署服务
```

侧边栏导航从 3 项简化为 2 项（模型服务 + 模型商店）。

---

## DD-009: 大文件下载 int32 溢出

**背景**: 下载 Qwen3.5-27B（55GB）时报 `value out of int32 range` 错误。

**原因**: `model_downloads.total_size` 字段类型是 `Integer`（int32，最大 ~2.1GB）。

**修复**: `Integer` → `BigInteger`，同时 `ALTER TABLE` 修改已有 PostgreSQL 表。

**教训**: 文件大小字段永远用 BigInteger。

---

## DD-010: httpx 连接池 — /simplify 发现的 P0 bug

**背景**: /simplify 代码审查发现 `_get_client()` 每次请求创建新的 `httpx.AsyncClient`，完全没有连接池效果。

**影响**: 每次 API 调用都要完整的 TCP 握手，高并发时性能严重退化。

**修复**: 改为模块级单例，所有请求复用同一个 AsyncClient（max_connections=50, max_keepalive_connections=20）。

---

## DD-011: 两个项目能力对比与拉平策略

**背景**: llm-platform fork 自 ts-platform，但服务管理能力有差距。

**差距分析和补齐**:

| 能力 | ts-platform | llm-platform 补齐状态 |
|------|-------------|---------------------|
| 表单联动 | 有 | ✅ 已实现 |
| round-robin | 有 | ✅ 已实现 |
| 健康缓存 | 30s | ✅ 30s |
| 进程启停 | Port-as-Truth | ✅ + systemd 检测 |
| ensure_running | 有 | ✅ 已实现 |
| 卡片布局 | 有 | ✅ 已实现 |
| GPU 参数面板 | 有 | ✅ 已实现 |
| 连接测试 | 有 | ✅ 已实现 |

两个项目服务管理能力已拉平。llm-platform 额外多了 systemd 检测（兼容逻辑）。
