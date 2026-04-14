# LLM Platform — TODO

> Updated: 2026-04-14

## Completed

- [x] OpenAI 兼容 API（/v1/chat/completions, /v1/completions, /v1/models）
- [x] API Key + JWT 双认证 + 限流
- [x] 多模型路由（model name → vLLM endpoint）+ round-robin 负载均衡
- [x] 健康检查缓存（30s TTL，并发检测，跳过不可达实例）
- [x] 请求日志（token 用量、延迟、错误追踪）
- [x] PostgreSQL 数据库（docker-compose.dev.yml，端口 5433）
- [x] 流式响应（SSE 原生转发 + 非 SSE 后端自动包装）
- [x] ensure_running（请求到达时自动拉起 vLLM 进程）
- [x] Dashboard（统计卡片 + GPU 监控置顶 + 3 个 ECharts 图表 + 最近请求）
- [x] Chat UI（多轮对话、流式显示、参数面板、模型选择）
- [x] 模型服务（卡片布局、GPU 参数面板、启停、systemd 检测、日志、健康圆点）
- [x] 服务表单交互联动（选模型自动填路径、改参数实时更新命令、连接测试）
- [x] 模型商店（ModelScope 搜索/下载/发布 + "已发布"标签页）
- [x] API 调用监控（分页、5 个筛选器、详情展开）
- [x] API 接入文档页（/api-docs，代码示例、认证、限流说明）
- [x] 全站中文化（7 页面 ~134 字符串）
- [x] 进程管理（Port-as-Truth + systemd 自动检测）
- [x] /simplify 代码审查（连接池单例、FD 泄漏修复、索引、工具函数提取）

## Planned

### P1 — 短期

| 项目 | 说明 |
|------|------|
| **端到端浏览器验收** | 逐页面点验，修交互细节和 Bug |
| **Alembic 数据库迁移** | 生成正式迁移脚本（当前 DEBUG=true auto-create） |
| **Docker 生产部署** | 实测构建镜像 + docker-compose up + nginx 代理 |

### P2 — 中期

| 项目 | 说明 |
|------|------|
| **用量配额** | 按 API Key 设置 token 用量上限 |
| **请求/响应详情** | 可选记录完整请求体（调试用） |
| **模型加载进度** | 卡片显示启动进度百分比 |
| **请求队列** | 高并发时排队 + 超时控制 |
| **Webhook 回调** | 请求完成后通知外部系统 |

### P3 — 远期

| 项目 | 说明 |
|------|------|
| **多机部署** | 支持注册远程 vLLM 实例 |
| **监控告警** | 延迟飙升/错误率异常 → 通知 |
| **模型性能基准** | 自动 benchmark，记录推理速度 |
| **A/B 测试** | 同请求发到多个模型，对比输出 |
| **微调集成** | 平台内发起 LoRA 微调任务 |
