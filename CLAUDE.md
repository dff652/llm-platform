# LLM Platform — 大语言模型推理网关

> 本文件供 AI 编码工具（Claude Code / Cursor 等）自动加载，提供项目全局上下文。

## 工程原则

> 问题尽早失败、在现场暴露；日志和诊断可预测；配置有单一事实源；发布可复现，运维可验证。

1. **显式失败优于隐式兜底** — 配置缺失、路径不存在、依赖不满足时立即失败；不 `mkdir -p` 兜底、不静默降级、不带病运行
2. **错误出现在使用现场** — UI 操作失败有 toast / 表单 / 卡片反馈；后端做最终校验；能在保存时拦截的不等运行时才报
3. **日志跟随进程，位置可预测** — 绝对路径写日志，不依赖 CWD；vLLM 子进程日志固定写 `logs/engines/<service>.log`
4. **诊断能力产品化** — 健康检查、配置校验、限流配额、Token 用量通过 API 暴露；SSH 是最后手段
5. **单一事实源** — 配置 / 版本 / 模型路由有唯一权威来源；不允许脚本、前端、后端、文档各写一套
6. **发布可复现** — 部署包不依赖构建机隐式状态；镜像有版本 tag + git commit；`/health` 与镜像版本一致
7. **运维动作可验证** — 每个修复、部署步骤、规避方案配套验证命令或验收标准

完整版判断标准和示例见 `docs/engineering-principles.md`。

**网关层 LLM 输出稳定性策略**（透传完整 vs 网关增强 vs 库层 SDK）见 `docs/gateway-stability-strategy.md` —— 当前定位是 Layer A 透传，**不内嵌响应解析逻辑**，结构化输出由 vLLM 约束解码 + 客户端自行处理。

## 绝对禁止

- **不使用 D3.js** — 所有可视化基于 ECharts
- **不删除 Git 分支** — 未经用户确认不得删除任何分支
- **字节 / 大小字段不得用 `Integer`** — 所有 `*_size` / `*_bytes` / `total_*` / `downloaded_*` 等字节数字段 ORM 一律 `BigInteger`（PostgreSQL BIGINT）。`Integer` 上限 2.1GB，模型权重单文件就远超（已遇 51.8GB），asyncpg 会抛 `value out of int32 range`。`model_download` 表是高发区
- **大文件（>5MB）不得入 git** — 部署包走制品库、模型权重走对象存储或 ModelScope；`.gitignore` 必须覆盖 `*.tar.gz` / `*.whl` / `*.bin` / `*.safetensors`
- **ORM `Column` 类型变更必写 alembic ALTER migration** — 把 `Enum(...)` 改成 `String(N)`、`Integer` 改成 `BigInteger` 等任何类型变更，必须配 `op.alter_column`。仅依赖 `Base.metadata.create_all()` 兜底建库会让"新部署 OK / 跨版本升级 DB 列还是旧类型"，跨版本机器塞新值会 asyncpg `DatatypeMismatchError`
- **Alembic `rm versions/*.py` 必须同时改所有 `down_revision` 引用** — 删除 revision 文件时如有 merge revision 还在 `down_revision=(A, B)` 方式引用它，DAG 构建时 `KeyError` 炸；预防：删 revision 后跑 `alembic heads` 必须单 head
- **Celery `@task` 装饰器禁止写超时字面量** — 不允许 `@celery_app.task(soft_time_limit=N, time_limit=M)`。装饰器是 import 时立即求值，写了字面量就**绑死**那一刻的值，运行时改 `.env` 改不动它。统一在 `core/celery_app.py` 用 `celery_app.conf.task_annotations` 从 `settings` 读，admin UI 改 `system_config` 立即生效。模型下载任务可能跑很久，超时设置必须可调

## 跨端约定（防漂移）

项目里"前后端各有一份字符串列表"的地方必须成对维护。**加新值时 checklist**：

- 新增 `system_config DEFAULTS` key → 同步注册 `Settings.tsx` 配置组
- 新增 `llm_service.status` 值（如 `enabled` / `disabled`）→ 同步前端 `types/index.ts` union + `ServiceList.tsx` `dotState` 五值映射（`disabled` / `healthy` / `starting` / `checking` / `offline`）
- 新增 `chat_log.status` / `model_download.status` 值 → 同步 `types/index.ts` + 对应列表页的 Badge 渲染
- 新增 `Role` 值（当前 `admin` / `user`）→ 同步 `types/index.ts` + `RoleRoute` 守卫

**配置不漂移**：

- 加 `Settings` 字段 → 同步看是否要 `system_config DEFAULTS`（运行时可调，admin UI 秒级生效）或 `.env.example`（部署期必填）。生产必填字段**禁止留 dev 默认值**，用 pydantic `Field(...)` 强制（缺即启动失败）
- 加 `@celery_app.task` 装饰器 → 超时禁字面量（见上 §绝对禁止），统一在 `celery_app.conf.task_annotations` 从 `settings` 读
- 改 `docker-compose.yml` services → 同步 `scripts/` 部署脚本和 `.env.example` env vars
- `manage.sh restart` → `up -d`：`.env` 变更后绝不能用 `restart`（不重读 env_file），必须 `up -d --force-recreate`
- **切分支 / `git pull` 后** → `cd backend && PYTHONPATH=. alembic current` 对比 `alembic heads`，不一致跑 `alembic upgrade head` 再用。dev 启动**不会**自动跑 migration，只重启 uvicorn；ORM 引用了 DB 没有的列时 asyncpg `UndefinedColumnError` → 500，故障在 UI 层会冒充成"列表为空"
- **前端 `Promise.allSettled` / `try-catch` 数据获取不得静默吞错**（违反原则 2）：rejected 分支必须 toast 或可见错误条，用 `useRef` 去重避免相同错误反复弹（参见 `ServiceList.tsx::lastErrorsRef` 实现）。silent swallow 让后端 5xx 在 UI 表现为"列表为空"，跟"DB 真无数据"无法区分。code review 必检 `services/api.ts` 调用点的错误分支

## 项目概述

LLM Platform 是一个 OpenAI 兼容的 LLM 推理 API 网关，基于 ts-platform 基础设施 fork 而来。

**核心功能**：
- **OpenAI 兼容 API**：`/v1/chat/completions`, `/v1/completions`, `/v1/models`
- **多模型路由 + Round-Robin 负载均衡**：同一模型多实例自动轮询分发
- **卡片式服务管理**：交互式 GPU 参数面板，自动生成启动命令
- **进程管理**：subprocess 启动 + systemd 服务检测/停止（Port-as-Truth 方案）
- **监控仪表盘**：GPU 状态、请求趋势、Token 用量、模型分布、最近请求
- **模型商店**：ModelScope 搜索下载，三 Tab（模型浏览/下载管理/已发布）
- **API 文档页**：内置接入指南（/api-docs）

详细设计决策见 `docs/design-decisions.md`。

## 技术栈

| 层 | 技术 | 版本 |
|------|------|------|
| 前端框架 | React + TypeScript | 19 / 5.9 |
| 构建工具 | Vite | 7 |
| 状态管理 | Zustand | 5 |
| 图表 | ECharts (echarts-for-react) | 5/3 |
| CSS | CSS Modules + CSS Variables | — |
| 后端 | FastAPI + SQLAlchemy async | 0.135+ / 2.0 |
| 任务队列 | Celery + Redis | 5.3+ |
| 认证 | JWT (PyJWT) + bcrypt | — |
| 数据库 | PostgreSQL / SQLite | — |

## 关键约定

### 命名规范
- 前端：camelCase（变量、函数、组件 props）
- 后端：snake_case（Python 变量、数据库字段、API 响应）
- API 层：`services/api.ts` 自动转换 snake_case <-> camelCase

### 角色
两个角色：`admin`、`user`。

### 组件模式
- CSS Modules（`*.module.css`），不用 styled-components 或 Tailwind
- 共享组件放 `frontend/src/components/common/`

## 项目结构

```
llm-platform/
├── CLAUDE.md                ← 你正在读的文件
├── TODO.md                  ← 待办事项和规划
├── docs/
│   └── design-decisions.md  ← 设计决策记录
├── frontend/
│   ├── CLAUDE.md            ← 前端开发约定
│   ├── src/
│   │   ├── App.tsx          ← 路由配置
│   │   ├── components/      ← 共享组件 (Layout, common)
│   │   ├── pages/
│   │   │   ├── Dashboard/   ← 总览 (GPU + 请求统计 + ECharts 图表)
│   │   │   ├── Chat/        ← 对话测试界面
│   │   │   ├── Services/    ← 模型服务 (卡片布局 + GPU 参数面板 + 启停)
│   │   │   ├── ModelStore/  ← 模型商店 (浏览/下载管理/已发布 三 Tab)
│   │   │   ├── ApiDocs/     ← API 接入文档
│   │   │   ├── ApiCalls/    ← API 调用日志
│   │   │   ├── ApiKeys/     ← API 密钥管理
│   │   │   ├── Settings/    ← 系统设置
│   │   │   ├── UserManagement/
│   │   │   └── Login/
│   │   ├── stores/          ← Zustand stores
│   │   ├── services/api.ts  ← API 客户端
│   │   ├── types/index.ts   ← TypeScript 类型
│   │   └── styles/          ← CSS Variables
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py          ← FastAPI 入口
│   │   ├── api/
│   │   │   ├── openai_api.py    ← OpenAI 兼容端点 (/v1/)
│   │   │   ├── llm_services.py  ← 服务 CRUD + 进程管理 (start/stop/logs)
│   │   │   ├── dashboard.py     ← 监控统计 (overview/trend/token-usage/distribution)
│   │   │   ├── auth.py, users.py, api_keys.py
│   │   │   ├── model_store.py   ← 模型商店
│   │   │   ├── system_config.py, system_logs.py
│   │   │   ├── events.py        ← SSE 事件
│   │   │   └── deps.py          ← 依赖注入 (JWT/API Key 认证)
│   │   ├── services/
│   │   │   ├── llm_router.py    ← 模型路由 (model → endpoint, 60s 缓存, round-robin)
│   │   │   ├── model_store/     ← 模型下载服务
│   │   │   └── auth_service.py, user_service.py
│   │   ├── schemas/
│   │   │   ├── openai.py        ← OpenAI 请求/响应 schema
│   │   │   ├── model_store.py   ← 模型商店 schema
│   │   │   └── auth.py, user.py
│   │   ├── models/
│   │   │   ├── llm_service.py   ← vLLM 服务实例 (name, endpoint, exec_command)
│   │   │   ├── chat_log.py      ← API 调用日志 (tokens, latency, status)
│   │   │   ├── user.py, api_key.py
│   │   │   ├── model_download.py, system_config.py
│   │   │   └── __init__.py      ← 注册所有 ORM 模型
│   │   ├── core/
│   │   │   ├── config.py        ← Pydantic Settings (.env)
│   │   │   ├── database.py      ← SQLAlchemy async engine
│   │   │   ├── security.py      ← JWT + bcrypt
│   │   │   ├── rate_limiter.py  ← Redis 限流
│   │   │   ├── celery_app.py    ← Celery (模型下载任务)
│   │   │   ├── subprocess_manager.py ← Redis + Celery 自动拉起
│   │   │   └── logging_config.py
│   │   └── tasks/               ← Celery 任务
│   └── scripts/seed.py          ← 初始化 admin 用户 + API Key
└── docker-compose.dev.yml       ← 开发用 PostgreSQL (:5433)
```

**侧边栏导航**:
```
总览
Chat
模型管理 >
  ├── 模型服务
  └── 模型商店
API 文档
系统管理 > (admin)
  ├── API 调用
  ├── 用户管理
  ├── API 密钥
  ├── 系统设置
  └── 系统日志
```

## API 端点总览

### OpenAI 兼容 API（/v1/）

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | Chat 补全（流式/非流式） |
| `POST /v1/completions` | 文本补全 |
| `GET /v1/models` | 列出可用模型 |

### 平台管理 API（/api/v1/）— 约 48 个端点

| 模块 | 前缀 | 端点数 | 说明 |
|------|------|--------|------|
| 认证 | `/api/v1/auth` | 3 | login, me, change-password |
| 用户 | `/api/v1/users` | 6 | CRUD |
| 服务管理 | `/api/v1/services` | 9 | CRUD + health + start/stop/process/logs |
| 模型商店 | `/api/v1/model-store` | 8+ | 搜索/下载/发布 |
| API 密钥 | `/api/v1/api-keys` | 5 | CRUD + 限流配置 |
| Dashboard | `/api/v1/dashboard` | 6 | overview + gpu + trend + token-usage + distribution + recent |
| 系统设置 | `/api/v1/system-config` | 2 | GET/PUT 全局配置 |
| 系统日志 | `/api/v1/system-logs` | 4 | 日志查看 + 性能统计 |

## 请求路由机制

1. 客户端发送 `POST /v1/chat/completions` + `model: "xxx"`
2. `openai_api.py` 通过 API Key 或 JWT 认证
3. `llm_router.py` 查询 `llm_services` 表，匹配 `model_name` 或 `name`（60s 缓存）
4. 同一模型多实例时，使用 **round-robin 负载均衡** 选择后端
5. 代理转发到 vLLM 后端（流式: SSE 原生转发 / 非 SSE: 包装为 `data:` 格式）
6. `chat_logs` 表记录请求日志

## 进程管理（Port-as-Truth）

- 服务配置 `exec_command` 后，可通过管理页面启停
- 启动: `subprocess.Popen(exec_command)` -> 轮询端口直到可达
- 停止: 优先检测 **systemd 服务**；否则 `lsof -ti :port` 找 PID -> SIGTERM -> SIGKILL
- 日志保存在 `logs/engines/{service_name}.log`

## 开发环境

```bash
# 后端（Redis + Celery 自动拉起）
cd backend
python3 -m uvicorn app.main:app --port 8200

# 前端（Vite 代理 /api → :8200, /v1 → :8200）
cd frontend
npm run dev          # :5175

# 初始用户
admin / admin123
```

### 最小化 dev 启动（无 Docker / 无 Redis 也能跑）

需要快速验证前端 / API 行为时（无下载任务、无限流压测需求），可走纯 SQLite + 无 Redis 路径：

```bash
# 系统级一次性
sudo apt install -y python3-pip python3-venv

# backend 一次性
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 写入最小 .env（DEBUG=true 触发 Base.metadata.create_all 自动建表）
printf 'JWT_SECRET=dev-secret-change-me\nDEBUG=true\n' > .env

# 初始化（admin/admin123 + 3 把 API Key）
PYTHONPATH=. .venv/bin/python3 scripts/seed.py

# 起服务（后台）
PYTHONPATH=. .venv/bin/python3 -m uvicorn app.main:app --port 8200
```

降级行为：

- 无 `redis-server` → `subprocess_manager` 仅 `logger.warning`，后端继续启动；模型下载（Celery）/ 限流功能不可用
- 默认 `DATABASE_URL=sqlite+aiosqlite:///./app.db` — 与 prod 的 PostgreSQL 路径不同，asyncpg 特定行为（如 BigInteger int32 溢出）测不到，正式压测/部署仍需 docker 起 PG 5433
- 默认 `JWT_SECRET="change-me-in-production"` 会被 `app/main.py` lifespan 阶段 RuntimeError 拒绝启动 — 必须显式覆盖（见上）。注：当前实现是运行时 check，不是 pydantic `Field(...)` 强制，效果相同但严格度略弱
