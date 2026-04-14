# LLM Platform — 大语言模型推���网关

> 本���件供 AI 编码工��（Claude Code / Cursor ��）自动加载，提供项目���局上下文。

## 项目概述

LLM Platform 是一个 OpenAI 兼容的 LLM 推理 API 网关，基于 ts-platform 基础设施 fork 而来。

**核心功能**：
- **OpenAI 兼容 API**：`/v1/chat/completions`, `/v1/completions`, `/v1/models`
- **多模型路由**：请求按 model 名称自动路由到对应 vLLM 后端
- **API Key 认证 + 限流**：支持 JWT 和 API Key 双认证
- **进程管理**：通过 Web 界面启停 vLLM 进程（Port-as-Truth 方案）
- **监控仪表盘**：GPU 状态、请求趋势、Token 用量、模型分布、最近请求
- **模型商店**：ModelScope 下载、注册、发布
- **API 文档页**：内置接入指南（/api-docs）

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
- API 层：`services/api.ts` 自动转换 snake_case ↔ camelCase

### 角色
两个角色：`admin`、`user`。

### 组件模式
- CSS Modules（`*.module.css`），不用 styled-components 或 Tailwind
- 共享组件放 `frontend/src/components/common/`

## 项目结��

```
llm-platform/
├── CLAUDE.md                ← 你正在读的文件
├── TODO.md                  ← 待办事项和规划
├── frontend/
│   ├─�� CLAUDE.md            ← 前端开发约定
│   ├── src/
│   │   ├── App.tsx          ← 路由配置
│   │   ├── components/      ← 共享组件 (Layout, common)
│   │   ├─�� pages/
│   │   │   ├── Dashboard/   ← 总览 (GPU + 请求统计 + ECharts 图表)
│   │   │   ├── Services/    ← vLLM 服务管理 (CRUD + 进程启停)
│   │   │   ├── ApiDocs/     ← API 接入文档
│   │   │   ├── ModelCenter/ ← 模型注册表
│   │   │   ├── ModelStore/  ← 模型商店 (下载/发布)
│   │   │   ├── ApiKeys/     ← API 密钥管理
│   │   │   ├── Settings/    ← 系统设置 + 日志
│   │   │   ├── UserManagement/
│   │   │   └── Login/
���   │   ├── stores/          ← Zustand stores
│   │   ├── services/api.ts  ��� API 客户端
│   │   ├── types/index.ts   ← TypeScript 类型
│   │   └── styles/          ← CSS Variables
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py          ← FastAPI 入口
│   │   ├── api/
│   │   │   ├─�� openai_api.py    ← OpenAI 兼容端点 (/v1/)
│   │   │   ├── llm_services.py  ← 服务 CRUD + 进程管理 (start/stop/logs)
│   │   │   ├── dashboard.py     ← 监控统计 (overview/trend/token-usage/distribution)
│   │   │   ├��─ auth.py, users.py, api_keys.py
│   │   │   ├── models.py        ← 模型注册
│   │   │   ├── model_store.py   ← 模型商店
│   │   │   ├── system_config.py, system_logs.py
│   │   │   ├── events.py        ← SSE 事件
│   │   │   └── deps.py          ← 依赖注入 (JWT/API Key 认证)
│   ���   ├── services/
│   │   │   ├── llm_router.py    ← 模型路由 (model → endpoint, 60s 缓存)
│   │   │   ├── model_store/     ← 模型下载服务
│   │   │   └── auth_service.py, user_service.py, model_service.py
│   │   ├── schemas/
│   │   │   ├── openai.py        ← OpenAI 请求/响应 schema
│   ��   │   ├── model_store.py   ← 模型商店 schema
│   │   │   └── auth.py, user.py, model_entity.py
│   │   ├── models/
│   │   │   ├── llm_service.py   ← vLLM 服务实例 (name, endpoint, exec_command)
│   │   │   ├── chat_log.py      ← API 调用日志 (tokens, latency, status)
│   │   │   ├── user.py, api_key.py, model_entity.py, model_version.py
│   │   │   ├── model_download.py, system_config.py
│   │   │   └── __init__.py      ← 注册所有 ORM 模型
│   │   ├── core/
│   │   │   ├── config.py        ← Pydantic Settings (.env)
│   │   │   ├── database.py      ← SQLAlchemy async engine
│   │   │   ├── security.py      ← JWT + bcrypt
│   │   │   ├── rate_limiter.py  ← Redis 限流
│   │   │   ├── celery_app.py    ← Celery (模型下载任务)
│   │   │   ├── subprocess_manager.py ← Redis + Celery 自动拉起
│   │   │   ��── logging_config.py
│   │   └── tasks/               ← Celery 任务
│   └── scripts/seed.py          ← 初始化 admin 用户 + API Key
└── docker-compose.dev.yml       ← 开发用 PostgreSQL (:5433)
```

## API 端点总览

### OpenAI 兼容 API（/v1/）

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | Chat 补全（流式/非流式） |
| `POST /v1/completions` | 文本补全 |
| `GET /v1/models` | 列出可用模型 |

### 平台管理 API（/api/v1/）

| 模块 | 前缀 | 端点数 | 说明 |
|------|------|--------|------|
| 认证 | `/api/v1/auth` | 3 | login, me, change-password |
| 用户 | `/api/v1/users` | 6 | CRUD |
| 服务管理 | `/api/v1/services` | 9 | CRUD + health + start/stop/process/logs |
| 模型注册 | `/api/v1/models` | 5 | CRUD + delete |
| 模型商店 | `/api/v1/model-store` | 8+ | 搜索/下载/发布 |
| API 密��� | `/api/v1/api-keys` | 5 | CRUD + 限流配置 |
| Dashboard | `/api/v1/dashboard` | 6 | overview + gpu + trend + token-usage + distribution + recent |
| 系统设置 | `/api/v1/system-config` | 2 | GET/PUT 全局配置 |
| 系统日志 | `/api/v1/system-logs` | 4 | 日志查看 + 性能统计 |

## 请求路由机制

1. 客户端发送 `POST /v1/chat/completions` + `model: "xxx"`
2. `openai_api.py` 通过 API Key 或 JWT 认证
3. `llm_router.py` 查询 `llm_services` 表，匹配 `model_name` 或 `name`（60s 缓存）
4. 代理转发到 vLLM 后端（流式: SSE 原生转发 / 非 SSE: 包装为 `data:` 格式）
5. `chat_logs` 表记录请求日志

## 进程管理（Port-as-Truth）

- 服务配置 `exec_command` 后，可通过管理页面启停
- 启动: `subprocess.Popen(exec_command)` → 轮询端口直到可达
- 停止: `lsof -ti :port` 找 PID → SIGTERM → SIGKILL
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
