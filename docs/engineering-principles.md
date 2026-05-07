# 工程原则（完整版）

> 本文件是 `CLAUDE.md` 顶部「工程原则」7 条精炼版的完整判断标准 + 示例。
> 来源：从 ts-platform `docs/tech-decisions.md` TD-037 + v2.0.1 / v2.0.3 / v2.0.4
> 三次生产部署踩坑沉淀中筛选出与 llm-platform 相关的部分（删除了 ts-platform
> 容器 / GPU Agent 双边界专属内容；对 llm-platform 不直接适用的"原则 5：跨边界
> 必须显式"未列入，因 llm-platform 后端就在宿主机或单容器内，无双边界）。

---

## 原则 1：显式失败优于隐式兜底

配置错误、路径不存在、环境不匹配、依赖缺失时，系统应在启动阶段或操作提交阶段
立即失败。不应通过自动创建目录、静默使用默认值、自动降级、忽略异常等方式掩盖
问题。生产系统不允许"带病运行"。

**判断标准：**

- 缺必要配置：启动失败
- 路径不存在：操作失败并说明原因
- 依赖未安装：构建或启动失败
- 不确定状态：拒绝继续，而不是猜测执行

**实现示例：**

- `core/config.py` 生产必填字段（如 `JWT_SECRET`、`DATABASE_URL`）应在
  startup 阶段拒绝默认值；缺即启动 RuntimeError。当前实现：`app/main.py`
  lifespan 检查 `JWT_SECRET == "change-me-in-production"` 时直接 raise
  RuntimeError —— 等价效果但严格度比 pydantic `Field(...)` 弱（默认值仍存在
  于 schema）。正确进化方向是改为 pydantic `Field(...)`，让 IDE / OpenAPI
  schema 也能直接看出"此字段必填"
- 模型下载前 disk space 预检：剩余 < 需要 → 直接 toast 报错并拒绝下载（参见
  `pages/ModelStore/ModelStore.tsx`）
- vLLM 启动 `subprocess.Popen` 后必须轮询端口可达，超时则按失败上报，不假装"启动了"

**反例：**

- `os.makedirs(path, exist_ok=True)` 兜底创建用户没声明的目录
- 数据库连接失败时退化到 SQLite 内存库继续跑

---

## 原则 2：错误必须出现在使用现场

错误要在用户触发操作的地方暴露，而不是只写入日志。后端必须做最终校验；前端
负责提前提示和改善体验。能在保存时拦截的问题，不应等到运行时才失败。

**判断标准：**

- UI 操作失败要有 toast、表单错误、卡片状态或明确提示
- API 返回错误必须可读、可行动
- 日志是辅助诊断，不是主要反馈渠道
- 后端校验优先于前端校验

**实现示例：**

- `ServiceList.tsx::checkHealth` / `checkProcess`：失败用 `lastErrorsRef` 去重
  toast，不静默 `setHealthy=false`（v2.0.4 ts-platform 引擎管理"列表为空"假象
  教训移植）
- 服务保存时校验 `endpoint` 格式 + 端口可解析，不等 start 才报
- API Key 限流命中时 HTTP 429 + `Retry-After` header + 响应体写明剩余配额

**反例（已知踩坑模式）：**

```tsx
// 错误：silent swallow 让后端 5xx 表现成"列表为空"
useEffect(() => {
  api.get('/services').then(setServices).catch(() => {});
}, []);

// 正确：错误显式 toast，用 ref 去重避免轮询轰炸
const lastErrorRef = useRef<string | null>(null);
useEffect(() => {
  api.get('/services').then((data) => {
    setServices(data);
    lastErrorRef.current = null;
  }).catch((err) => {
    const detail = err instanceof ApiError ? err.detail : '加载失败';
    if (lastErrorRef.current !== detail) {
      lastErrorRef.current = detail;
      showToast({ type: 'error', message: detail });
    }
  });
}, []);
```

---

## 原则 3：日志跟随进程，位置必须可预测

进程在哪里运行，日志就应该写到该运行边界内的明确绝对路径。不能依赖当前工作
目录。

**判断标准：**

- 日志路径使用绝对路径
- 子进程（vLLM）日志写到固定目录（`logs/engines/<service>.log`）
- 错误响应中尽量带日志尾部或日志位置（如 `/services/{id}/logs?lines=N`）

**实现示例：**

- `subprocess_manager.py` 启动 vLLM 时显式打开 `<LOG_DIR>/engines/<name>.log`
  作为 stdout/stderr，每次 start 覆写
- `/services/{id}/logs` API 暴露最近 N 行，便于前端"日志"按钮直接看，不需
  SSH 到机器

---

## 原则 4：诊断能力必须产品化

健康检查、配置校验、限流配额、Token 用量、模型完整性等诊断信息，应通过 API
暴露，并能被前端或脚本消费。SSH 到生产机只能作为最后手段。

**判断标准：**

- 关键状态有 API（健康、版本、配额、磁盘空间、模型完整性）
- 前端能展示诊断结果
- 启动自检结果可从日志和 API 双向确认

**实现示例：**

- `/health` 暴露 build_time / git commit / version
- `/services/{id}/health` 暴露 vLLM 后端健康 + maxModelLen + 错误详情
- `/api-keys/me` 暴露当前 key 的 `token_used` / `token_quota` / `rpm_limit`
- `/model-store/disk-space` 暴露磁盘剩余，前端下载前预检

---

## 原则 5：单一事实源

配置、版本、模型路由、服务状态、migration head 等信息必须有明确权威来源，
避免脚本、前端、后端、文档各写一套。

**示例：**

- 模型路由以 `llm_services` 表的 `model_name` 为准（`llm_router.py` 60s 缓存
  上层），不在前端硬编码模型 → endpoint 映射
- Alembic head 以 `alembic heads` 实际输出为准，文档和脚本必须同步；切分支后
  先 `alembic current` 对比再决定是否 `upgrade head`
- 超时配置以 `system_config` 为准，admin UI 改即生效；不允许 Celery 装饰器写
  字面量绑死（见 CLAUDE.md §绝对禁止）
- 角色枚举以 `types/index.ts::Role` 为权威，后端 `User.role` 字段值域必须与
  之严格一致

---

## 原则 6：发布必须可复现

生产部署包不能依赖构建机的隐式状态。

**示例：**

- 镜像不能只用 `latest`，必须有版本 tag（如 `2.0.4`）+ git commit + build time
- 离线部署包 README、镜像、`/health` 版本信息应一致
- 前端构建注入的环境变量（`VITE_*`）必须出现在 `.env.example` 里，部署人能
  看出来要传什么
- 模型权重不进 git 也不进镜像，走 ModelScope 下载或挂载已下载的目录

---

## 原则 7：运维动作必须可验证

每个修复、部署步骤、规避方案都必须配套验证命令或验收标准。

**示例：**

- 修服务启停 → 验证：在 UI 启动 → 卡片圆点变绿 → `/v1/chat/completions` 实际
  返回内容
- 修 round-robin → 验证：同模型多实例下连续发 6 个请求，看 `chat_logs` 表里
  `target_endpoint` 字段是否轮询分布
- 修限流 → 验证：手动用 curl 灌请求超过 `rpm_limit`，应返回 429
- DB schema 变更 → 验证：`alembic upgrade head` 后 `alembic current` 与 `heads`
  一致；ORM 字段在 PG 里 `\d table_name` 可见且类型对得上

---

## 与 v2.0.4（ts-platform）的关联

本文中以下条目是从 ts-platform v2.0.4 集成版（2026-04-29 发版）的踩坑教训
直接吸收：

- 原则 2 的 `lastErrorsRef` toast 去重模式 — 来自 ts-platform 引擎管理"列表
  为空"假象修复（v2.0.4 459e55c）
- 原则 5 的"切分支后跑 `alembic current` 对比 `alembic heads`" — 来自
  v2.0.4 同一事故的根因（DB schema 落后于 ORM）
- CLAUDE.md §绝对禁止 中的 Celery 装饰器超时禁字面量、Alembic 删 revision 同步
  改 down_revision、ORM 类型变更必写 ALTER migration、BigInteger 强约定 —
  均来自 ts-platform v2.0.1~v2.0.4 生产实战

llm-platform fork 自 ts-platform 基础设施，技术栈相同（FastAPI + Celery +
Redis + Alembic + React + Zustand），上述教训直接适用。

## llm-platform 自身的吞错普查（2026-05-07）

照搬 ts-platform v2.0.4 教训对前端做了一次 silent swallow 普查，共 11 处
`.catch(() => {})` / `try { ... } catch { /* ignore */ }`：

- **6 处 🔴/🟡 已修**：`ApiCalls.tsx` model-distribution、`Settings/SystemLogs.tsx`
  log sources、`ModelStore.tsx` 已发布 Tab（`Promise.all` → `Promise.allSettled`
  分别 toast）、`Chat.tsx` `/v1/models`（裸 `fetch` 补 `!r.ok` 分支）、
  `ApiDocs.tsx` `/v1/models`（内联错误条而非 toast，避免文档页 toast 干扰）、
  `Services/ServiceList.tsx::ServiceFormModal` 模型下拉 — 全部按原则 2 改为
  toast 或内联可见错误，错误内容用 `err instanceof ApiError ? err.detail : ...`
- **5 处 🟢 保留并加 `fallback by design:` 注释**：`ModelStore.tsx` 磁盘预检
  / 依赖关系（后端会再校验 / 用户决策）、`Sidebar.tsx` build_time（仅气泡展示）、
  `CompareModal.tsx` per-item null（UI 已处理空槽位）— 这些是有意降级，注释
  写明「为什么不报错」避免后人误以为也是吞错

**判断标准（普查时用的过滤器）**：失败会让 UI 出现"列表为空 / 下拉空白 / 表单
不可用"的归 🔴/🟡 必修；失败仅退化为「不显示某个辅助元素」且主流程不受影响的
归 🟢 保留 + 注释。

**预防**：code review 时见 `.catch(() => {})` 一律追问"这是有意 fallback 还是
silent swallow"，是有意就要写 `fallback by design:` 注释说明 why。
