# LLM Platform — 大语言模型推理网关

> 本文件供 AI 编码工具（Claude Code / Cursor 等）自动加载，提供项目全局上下文。

## 项目概述

LLM Platform 是一个 OpenAI 兼容的 LLM 推理 API 网关，基于 ts-platform 基础设施 fork 而来。

**核心功能**：
- **OpenAI 兼容 API**：`/v1/chat/completions`, `/v1/completions`, `/v1/models`
- **多模型路由**：请求按 model 名称自动路由到对应 vLLM 后端
- **API Key 认证 + 限流**：支持 JWT 和 API Key 双认证
- **模型管理**：模型商店下载、注册、vLLM 服务管理
- **监控仪表盘**：GPU 状态、请求统计、Token 用量、延迟追踪

## 技术栈

| 层 | 技术 | 版本 |
|------|------|------|
| 前端框架 | React + TypeScript | 19 / 5.9 |
| 构建工具 | Vite | 7 |
| 状态管理 | Zustand | 5 |
| CSS | CSS Modules + CSS Variables | — |
| 后端 | FastAPI + SQLAlchemy async | 0.110+ / 2.0 |
| 任务队列 | Celery + Redis | 5.3+ |
| 认证 | JWT (PyJWT) + bcrypt | — |
| 数据库 | PostgreSQL (asyncpg + psycopg2) | — |
| 推理后端 | vLLM | — |

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

## 项目结构

```
llm-platform/
├── CLAUDE.md                ← 你正在读的文件
├── frontend/
│   ├── src/
│   │   ├── App.tsx          ← 路由配置
│   │   ├── components/      ← 共享组件 (Layout, common)
│   │   ├── pages/
│   │   │   ├── Dashboard/   ← 总览 (GPU + 请求统计)
│   │   │   ├── Services/    ← vLLM 服务管理
│   │   │   ├── ModelCenter/ ← 模型注册表
│   │   │   ├── ModelStore/  ← 模型商店 (下载/发布)
│   │   │   ├── ApiKeys/     ← API 密钥管理
│   │   │   ├── Settings/    ← 系统设置 + 日志
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
│   │   │   ├── llm_services.py  ← vLLM 服务管理
│   │   │   ├── auth.py          ← 认证
│   │   │   ├── users.py         ← 用户管理
│   │   │   ├── models.py        ← 模型注册
│   │   │   ├── model_store.py   ← 模型商店
│   │   │   ├── api_keys.py      ← API 密钥
│   │   │   ├── dashboard.py     ← 监控统计
│   │   │   ├── system_config.py ← 系统设置
│   │   │   ├── system_logs.py   ← 日志查看
│   │   │   ├── events.py        ← SSE 事件
│   │   │   └── deps.py          ← 依赖注入
│   │   ├── services/
│   │   │   ├── llm_router.py    ← 模型路由 (model → endpoint)
│   │   │   ├── model_store/     ← 模型下载服务
│   │   │   └── ...
│   │   ├── schemas/
│   │   │   ├── openai.py        ← OpenAI 请求/响应 schema
│   │   │   └── ...
│   │   ├── models/
│   │   │   ├── llm_service.py   ← vLLM 服务实例
│   │   │   ├── chat_log.py      ← API 调用日志
│   │   │   └── ...
│   │   └── core/            ← 配置、安全、数据库、Celery
│   └── scripts/seed.py
└── docker/
```

## API 端点总览

### OpenAI 兼容 API（/v1/）

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | Chat 补全（流式/非流式） |
| `POST /v1/completions` | 文本补全（流式/非流式） |
| `GET /v1/models` | 列出可用模型 |

### 平台管理 API（/api/v1/）

| 模块 | 前缀 | 说明 |
|------|------|------|
| 认证 | `/api/v1/auth` | login, me, change-password |
| 用户 | `/api/v1/users` | CRUD |
| LLM 服务 | `/api/v1/services` | vLLM 服务 CRUD + 健康检查 |
| 模型注册 | `/api/v1/models` | 模型元数据管理 |
| 模型商店 | `/api/v1/model-store` | 下载/发布 |
| API 密钥 | `/api/v1/api-keys` | CRUD + 限流 |
| Dashboard | `/api/v1/dashboard` | GPU/请求统计 |
| 系统设置 | `/api/v1/system-config` | 全局配置 |
| 系统日志 | `/api/v1/system-logs` | 日志查看 |

## 开发环境

```bash
# 后端
cd backend
python3 -m uvicorn app.main:app --port 8100

# 前端
cd frontend
npm run dev          # Vite dev server :5175, 代理 /api → :8100

# 初始用户
admin / admin123
```

## 请求路由机制

1. 客户端发送 `POST /v1/chat/completions` + `model: "Qwen/Qwen2.5-7B-Instruct"`
2. `openai_api.py` 通过 API Key 或 JWT 认证
3. `llm_router.py` 查询 `llm_services` 表，找到 model_name 匹配的服务
4. 请求代理转发到对应 vLLM 后端（如 `http://localhost:8001/v1/chat/completions`）
5. 响应直接透传给客户端（流式 SSE 或 JSON）
6. `chat_logs` 表记录请求日志（token 用量、延迟等）
