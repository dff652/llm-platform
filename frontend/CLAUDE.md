# 前端开发约定

> 本文件供 AI 编码工具自动加载，提供前端开发上下文。

## 技术约定

- **React 19** + **TypeScript 5.9** + **Vite 7**
- **Zustand 5** 状态管理
- **React Router 7** 路由
- **ECharts** (echarts-for-react) 图表
- **Radix UI** 基础无样式组件
- **CSS Modules**（`*.module.css`），搭配全局 CSS Variables
- **不用 Tailwind / styled-components**

## 目录结构

```
src/
├── App.tsx                    ← 路由配置
├── components/
│   ├── common/                ← 共享组件（Badge, Modal, DataTable, Toast, Tabs, ConfirmDialog, Pagination...）
│   └── Layout/
│       ├── AppLayout.tsx      ← 侧边栏 + 顶栏 + Outlet
│       └── Sidebar.tsx        ← 导航（总览/Chat/模型管理/API文档/系统管理）
├── pages/
│   ├── Dashboard/             ← 仪表板（统计卡片 + GPU 监控 + ECharts 图表 + 最近请求）
│   ├── Chat/                  ← 对话界面（多轮、流式、参数面板）
│   ├── Services/              ← 模型服务（卡片布局、CRUD、启停、GPU 参数、日志）
│   ├── ModelStore/            ← 模型商店（浏览 + 下载 + 已发布 三标签页）
│   ├── ApiCalls/              ← API 调用监控（分页、筛选、详情展开）
│   ├── ApiDocs/               ← API 接入文档
│   ├── ApiKeys/               ← API 密钥管理
│   ├── Settings/              ← 系统设置 + 系统日志
│   ├── UserManagement/
│   └── Login/
├── stores/authStore.ts        ← 认证状态
├── services/api.ts            ← API 客户端（自动 snake↔camel 转换）
├── types/index.ts             ← TypeScript 类型
└── styles/global.css          ← CSS Variables
```

## 侧边栏导航

```
仪表板
Chat
模型管理 ▾
  ├── 模型服务
  └── 模型商店
API 文档
系统管理 ▾ (admin)
  ├── API 调用
  ├── 用户管理
  ├── API 密钥
  ├── 系统设置
  └── 系统日志
```

## API 客户端

```typescript
import { api, ApiError } from '../services/api';

// GET（自动带 JWT，自动 snake→camel 转换）
const services = await api.get<LLMService[]>('/services');

// POST（自动 camel→snake 转换）
await api.post('/services', { name: 'qwen', endpoint: 'http://...' });

// 错误处理
try { ... } catch (err) {
  if (err instanceof ApiError) console.error(err.status, err.detail);
}
```

## 关键设计模式

- 模型服务表单：选模型自动填路径、改 GPU 参数实时更新 exec_command
- 卡片布局：健康圆点（绿/蓝脉冲/红/灰）+ GPU Badge + 启停按钮
- 全站中文
