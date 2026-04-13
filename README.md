# LLM Platform — OpenAI 兼容推理网关

提供 OpenAI 兼容 API，将请求路由到多个 vLLM 后端实例。

## 快速开始

### 环境要求

- Node.js 18+
- Python 3.10+
- PostgreSQL
- Redis

### 1. 安装

```bash
git clone <repo-url> llm-platform
cd llm-platform

# 前端依赖
cd frontend && npm install && cd ..
```

### 2. 配置

```bash
cd backend
cat > .env << 'EOF'
JWT_SECRET=your-secret-key-change-in-production
DATABASE_URL=postgresql+asyncpg://llmuser:llmpass123@localhost:5432/llm_platform
DATABASE_SYNC_URL=postgresql+psycopg2://llmuser:llmpass123@localhost:5432/llm_platform
REDIS_URL=redis://localhost:6379/0
DEBUG=true
EOF

# 初始化数据库 & 创建 admin 用户
python3 scripts/seed.py
# 输出: admin / admin123
```

### 3. 启动

```bash
# 后端（自动拉起 Redis + Celery）
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8100

# 前端（另一个终端）
cd frontend && npm run dev
```

访问 http://localhost:5175，API 文档 http://localhost:8100/api/docs

### 4. 注册 vLLM 服务

登录后台 → 模型服务 → Add Service：

- **Name**: `qwen-7b`
- **Endpoint**: `http://localhost:8001`（你的 vLLM 地址）
- **Model Name**: `Qwen/Qwen2.5-7B-Instruct`（vLLM 报告的模型名）

### 5. 使用 API

```bash
# 生成 API Key: 登录后台 → API 密钥 → 创建

# 调用推理
curl http://localhost:8100/v1/chat/completions \
  -H "Authorization: Bearer ak-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 512
  }'
```

## 架构

```
Client → LLM Platform → vLLM Backend 1 (model A)
            ↓           → vLLM Backend 2 (model B)
            ↓           → vLLM Backend N (model N)
      Auth + Rate Limit
      Logging + Metrics
```

**核心流程**：
1. 请求到达 `/v1/chat/completions`
2. API Key / JWT 认证 + 限流
3. 按 `model` 字段查找对应 vLLM 后端
4. 代理请求（支持流式 SSE）
5. 记录日志（token 用量、延迟）

## 技术栈

| 层 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite 7 |
| 后端 | FastAPI + SQLAlchemy 2.0 async |
| 认证 | JWT + API Key + bcrypt |
| 数据库 | PostgreSQL |
| 缓存/队列 | Redis + Celery |
| 推理后端 | vLLM |
