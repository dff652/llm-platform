# LLM Platform — TODO

> Updated: 2026-04-14

## Completed

- [x] OpenAI 兼容 API（/v1/chat/completions, /v1/completions, /v1/models）
- [x] API Key + JWT 双认证 + 限流
- [x] 多模型路由（model name → vLLM endpoint）
- [x] 请求日志（token 用量、延迟、错误追踪）
- [x] PostgreSQL 数据库
- [x] 流式响应（SSE 原生 + 非 SSE 回退）
- [x] Dashboard（统计卡片 + 请求趋势 + 模型分布 + token 用量 + 最近请求表格 + GPU 监控）
- [x] API 接入文档页（/api-docs）
- [x] vLLM 进程管理（Start/Stop/Status/Logs）
- [x] 模型商店（ModelScope 下载/发布）

## In Progress

（无）

## Planned

### P1 — 短期

| 项目 | 说明 |
|------|------|
| **Chat UI** | 浏览器内对话界面，多轮会话，支持选择模型和参数 |
| **Alembic 迁移** | 生成正式数据库迁移脚本（当前 DEBUG=true auto-create） |
| **Docker 生产部署** | 更新 Dockerfile、docker-compose.yml、nginx.conf |

### P2 — 中期

| 项目 | 说明 |
|------|------|
| **多机部署** | 支持注册远程 vLLM 实例（非 localhost） |
| **负载均衡** | 同一模型多副本，round-robin 或 least-connections |
| **请求队列** | 高并发时排队 + 超时控制 |
| **用量配额** | 按 API Key 设置 token 用量上限 |
| **Webhook 回调** | 请求完成后通知外部系统 |

### P3 — 远期

| 项目 | 说明 |
|------|------|
| **模型性能基准** | 自动跑 benchmark，记录推理速度/质量 |
| **A/B 测试** | 同请求发到多个模型，对比输出 |
| **微调集成** | 平台内发起 LoRA 微调任务 |
| **监控告警** | 异常检测（延迟飙升/错误率异常）→ 通知 |
| **审计日志** | 记录所有管理操作（创建/删除服务、密钥等） |
