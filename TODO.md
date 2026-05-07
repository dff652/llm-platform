# LLM Platform — TODO

> Updated: 2026-05-07

## Completed (25 commits)

- [x] OpenAI 兼容 API（/v1/chat/completions, /v1/completions, /v1/models）
- [x] API Key + JWT 双认证 + 限流
- [x] 多模型路由（model name → vLLM endpoint）+ round-robin 负载均衡
- [x] 健康检查缓存（30s TTL，并发检测，跳过不可达实例）
- [x] 请求日志（token 用量、延迟、错误追踪）+ 请求/响应体详情
- [x] PostgreSQL 数据库（docker-compose.dev.yml，端口 5433）
- [x] Alembic 数据库迁移（3 个迁移脚本，正式管理 schema 变更）
- [x] 流式响应（SSE 原生转发 + 非 SSE 后端自动包装）
- [x] ensure_running（请求到达时自动拉起 vLLM 进程）
- [x] Dashboard（统计卡片 + GPU 监控置顶 + 3 个 ECharts 图表 + 最近请求）
- [x] Chat UI（多轮对话、流式显示、参数面板、模型选择）
- [x] 模型服务（卡片布局、GPU 参数面板、启停、systemd 检测、日志、健康圆点、上下文长度）
- [x] 服务表单交互联动（选模型自动填路径、改参数实时更新命令、连接测试）
- [x] 模型商店（ModelScope 搜索/下载/发布 + "已发布"标签页）
- [x] API 调用监控（分页、5 个筛选器、详情展开、请求/响应体查看）
- [x] API 接入文档页（/api-docs，代码示例、认证、限流说明）
- [x] Token 用量配额（按 API Key 限额，token_quota / token_used）
- [x] 全站中文化（7 页面 ~134 字符串）
- [x] 进程管理（Port-as-Truth + systemd 自动检测）
- [x] /simplify 代码审查（连接池单例、FD 泄漏修复、索引、工具函数提取）
- [x] 项目文档（README + CLAUDE.md + TODO.md + docs/design-decisions.md 11 个决策）
- [x] 清理 ts-platform 残留代码（DataSource/IoTDB/ModelCenter 死代码 -594 行）
- [x] 修复 httpx 健康检查单例、log_fh 泄漏、流式 JSON 转义
- [x] 修正 PerfStats 前后端类型不匹配（byAlgorithm → byModel）
- [x] 工程原则文档化（`docs/engineering-principles.md` 7 条 + CLAUDE.md 顶部精炼版）
- [x] 前端 silent swallow 普查：6 处 🔴/🟡 改 toast / 内联提示，5 处 🟢 加 `fallback by design:` 注释
- [x] `requirements.txt` 清 12 项 ts-platform 时序/异常检测死依赖（pandas/numpy/scipy/sklearn/statsmodels/adtk/kneed/pyod/PyWavelets/ruptures/tsdownsample/apache-iotdb），补完 -594 行清理的尾巴
- [x] 修正 `.env.example` postgres 端口（5432 → 5433），与 `docker-compose.dev.yml` / `alembic.ini` 对齐
- [x] CLAUDE.md「开发环境」补「最小化 dev 启动」段（无 Docker / 无 Redis 路径，SQLite + DEBUG=true 自建表）

## Next — 待执行

### P1 — 短期

| 项目 | 说明 | 状态 |
|------|------|------|
| **端到端浏览器验收** | 逐页面点验，修交互细节和 Bug | 待开始 |
| **Docker 生产部署** | 实测构建镜像 + docker-compose up + nginx 代理 | 待开始 |
| **API Key 管理页增强** | 显示 token_used/token_quota，支持配额编辑 | 待开始 |

### P2 — 中期

| 项目 | 说明 |
|------|------|
| **模型加载进度** | 启动中时卡片显示进度（端口轮询） |
| **请求队列** | 高并发时排队 + 超时控制 |
| **Webhook 回调** | 请求完成后通知外部系统 |
| **修补 alembic initial 迁移** | 当前 `96252e4767af_initial_schema.py` 只有 `create_index`，不含 `create_table`。新部署机器跨版本升级时会因表不存在炸（参见 2026-05-07 普查 SQLite 路径错误）。需补真正的 initial migration 或显式说明"建表靠 `Base.metadata.create_all()`，alembic 仅管 schema 演进"，二者其一明确 |
| **JWT_SECRET 改 pydantic Field(...)** | 当前 `core/config.py` 仍有默认值，靠 `main.py` lifespan 运行时 raise；改为 `Field(...)` 让 IDE/OpenAPI schema 也能看出必填 |

### P3 — 远期

| 项目 | 说明 |
|------|------|
| **多机部署** | 支持注册远程 vLLM 实例 |
| **监控告警** | 延迟飙升/错误率异常 → 通知 |
| **模型性能基准** | 自动 benchmark，记录推理速度 |
| **A/B 测试** | 同请求发到多个模型，对比输出 |
| **微调集成** | 平台内发起 LoRA 微调任务 |

## Development Timeline

| 日期 | 里程碑 |
|------|--------|
| 2026-04-13 | 项目初始化，Fork ts-platform，OpenAI API + 认证 + 模型路由 |
| 2026-04-13 | PostgreSQL 切换，流式响应验证，ChatTS 端到端测试通过 |
| 2026-04-14 | Dashboard 图表，API 文档页，Chat UI，进程管理 |
| 2026-04-14 | 全站中文化，GPU 监控增强，API 调用监控页 |
| 2026-04-14 | 模型服务 ↔ 注册联动，round-robin 负载均衡 |
| 2026-04-14 | 服务表单交互重写（参考 ts-platform ServiceForm） |
| 2026-04-14 | systemd 服务检测，模型注册合并到商店，卡片布局 |
| 2026-04-14 | 设计决策文档（11 项），项目文档全面更新 |
| 2026-04-14 | Alembic 迁移，Token 配额，请求/响应详情日志，上下文长度显示 |
| 2026-04-15 | 代码审查：清理 ts-platform 残留，修复 httpx/fd/JSON 三个 bug，PerfStats 类型对齐 |
| 2026-05-07 | 工程原则文档化（7 条）+ 前端吞错普查（11 处定位、6 修 5 加注释）+ 后端依赖清死项 + dev env 文档化 |
