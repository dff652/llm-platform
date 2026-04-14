# LLM Platform — OpenAI 兼容推理网关

提��� OpenAI 兼容 API，将请求路由到多个 vLLM 后端实例。支持认证、限流、日志、GPU 监控和进程管理。

## 功能概览

- **OpenAI 兼容 API**: `/v1/chat/completions`, `/v1/completions`, `/v1/models`
- **多模型路由**: 按 model name 自动路由到对应 vLLM 后端
- **流式响应**: SSE 原生转发，兼容非 SSE 后端
- **API Key 认证 + 限流**: 支持 JWT 和 API Key，可配置每分钟/小时/天限额
- **进程管理**: 通过 Web 界面启停 vLLM 进程，查看日志
- **监控仪表盘**: GPU 状态、请求趋势、Token 用量、模型分布、最近请求
- **模型商店**: 从 ModelScope 搜索/下载模型，一键发布到平台
- **API 文档**: 内置接入文档页（/api-docs），含代码示例

## 快速开始

### 环境要求

- Python 3.10+
- Node.js 18+
- PostgreSQL（或 SQLite 开发模式）
- Redis

### 1. 安装

```bash
git clone <repo-url> llm-platform
cd llm-platform

# 前端依赖
cd frontend && npm install && cd ..

# 后端依赖（如缺失）
pip install fastapi uvicorn sqlalchemy asyncpg psycopg2-binary \
    redis celery httpx pydantic-settings structlog bcrypt pyjwt \
    aiosqlite sse-starlette
```

### 2. 配置

```bash
cd backend

# 开发模式（SQLite，快速启动）
cat > .env << 'EOF'
DEBUG=true
JWT_SECRET=your-secret-key-here
DATABASE_URL=sqlite+aiosqlite:///./app.db
DATABASE_SYNC_URL=sqlite:///./app.db
EOF

# 生产模式（PostgreSQL）
# docker compose -f docker-compose.dev.yml up -d  # 启动 PostgreSQL
# DATABASE_URL=postgresql+asyncpg://llmuser:llmpass123@localhost:5433/llm_platform
# DATABASE_SYNC_URL=postgresql+psycopg2://llmuser:llmpass123@localhost:5433/llm_platform

# 初始化数据库 + 创建 admin 用户 + API Key
python3 scripts/seed.py
```

### 3. 启动

```bash
# 后端（自动拉起 Redis + Celery）
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8200

# 前端（另一个终端）
cd frontend && npm run dev
```

| 入口 | 地址 |
|------|------|
| 前端 | http://localhost:5175 |
| API 文�� | http://localhost:5175/api-docs |
| Swagger | http://localhost:8200/api/docs（需 DEBUG=true） |
| 默认账号 | admin / admin123 |

### 4. 注册 vLLM 服务

登录 → 模型服务 → Add Service：

| 字段 | 示例 |
|------|------|
| Name | `qwen-7b` |
| Endpoint | `http://localhost:8001` |
| Model Name | `Qwen/Qwen2.5-7B-Instruct`（vLLM 报告的名称） |
| Exec Command | `python -m vllm.entrypoints.openai.api_server --model /path --port 8001`（可选，用于进程管理） |

### 5. 调用 API

```bash
curl http://localhost:8200/v1/chat/completions \
  -H "Authorization: Bearer ak-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 512
  }'
```

Python OpenAI SDK:
```python
from openai import OpenAI
client = OpenAI(api_key="ak-xxx", base_url="http://localhost:8200/v1")
resp = client.chat.completions.create(model="Qwen/Qwen2.5-7B-Instruct", messages=[...])
```

## 架构

```
                     ┌─────────────────────────┐
                     │     LLM Platform         │
Client ──────────────┤  Auth + Rate Limit       │
  (OpenAI SDK/curl)  │  Model Router            ├──→ vLLM Backend 1 (model A)
                     │  Logging + Metrics       ├──→ vLLM Backend 2 (model B)
                     │  Process Management      ├──→ vLLM Backend N (model N)
                     └─────────────────────────┘
```

**请求流程**: 认证 → 路由 → 代理转发 → 日志记录 → 响应

## 项目结构

```
llm-platform/
├─�� backend/
│   ├── app/
│   │   ├── main.py              ← FastAPI 入口
│   ��   ├── api/
│   │   │   ├── openai_api.py    ← /v1/chat/completions, /v1/models
│   │   │   ├── llm_services.py  ← 服务 CRUD + 进程管理
│   │   │   ├── dashboard.py     ← 监控统计
│   │   │   ├── auth.py, users.py, api_keys.py
│   │   │   └── system_config.py, system_logs.py
│   │   ├── models/              ← ORM (llm_service, chat_log, user, api_key, ...)
│   │   ├── services/            ← 业务逻辑 (llm_router, model_store/)
│   │   ├── schemas/             ← Pydantic 模���
│   │   └── core/                ← 配置、安全、数据库、Celery
│   └── scripts/seed.py
├── frontend/
│   └── src/
│       ├── pages/               ← Dashboard, Services, ApiDocs, ModelCenter, ...
│       ├── components/          ← Layout, common (Badge, Modal, DataTable, ...)
│       ├── services/api.ts      ← API 客户端
│       └── types/index.ts       ← TypeScript 类型
├── TODO.md                      ← 待办事项和规划
└── docker-compose.dev.yml       ← 开发用 PostgreSQL
```

## API 端点

### OpenAI 兼容（/v1/）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/v1/chat/completions` | Chat 补全（流式/非流式） |
| POST | `/v1/completions` | 文本���全 |
| GET | `/v1/models` | 列出可用模型 |

### 平台管理（/api/v1/）

| 模块 | 前缀 | 端点数 |
|------|------|--------|
| 认证 | `/api/v1/auth` | 3 |
| 用户 | `/api/v1/users` | 6 |
| 服务管理 | `/api/v1/services` | 9 (CRUD + health + start/stop/process/logs) |
| 模型注册 | `/api/v1/models` | 5 |
| ��型商店 | `/api/v1/model-store` | 8+ |
| API 密钥 | `/api/v1/api-keys` | 5 |
| Dashboard | `/api/v1/dashboard` | 6 |
| 系统设��� | `/api/v1/system-config` | 2 |
| 系统日志 | `/api/v1/system-logs` | 4 |

## 技术栈

| 层 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript 5.9 + Vite 7 |
| 图表 | ECharts (echarts-for-react) |
| 状态管理 | Zustand 5 |
| CSS | CSS Modules + CSS Variables |
| 后端 | FastAPI + SQLAlchemy 2.0 async |
| 认证 | JWT (PyJWT) + bcrypt + API Key |
| 数据库 | PostgreSQL / SQLite |
| 缓存/��列 | Redis + Celery |
| 推理后�� | vLLM |
