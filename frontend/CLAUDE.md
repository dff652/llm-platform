# 前端开发约定

> 本文件供 AI 编码工具自动加载，提供前端开发上下文。

## 技术约定

- **React 19** + **TypeScript 5.9** + **Vite 7**
- **Zustand 5** 状态管理
- **React Router 7** 路由
- **Radix UI** 基础无样式组件
- **CSS Modules**（`*.module.css`），搭配全局 CSS Variables
- **不用 Tailwind / styled-components**

## 目录结构

```
src/
├── App.tsx                    ← 路由配置
├── components/
│   ├── common/                ← 共享组件
│   │   ├── AuthGuard.tsx      ← 未登录 → 跳转 /login
│   │   ├── GuestGuard.tsx     ← 已登录 → 跳转 /dashboard
│   │   └── RoleRoute.tsx      ← 角色权限守卫
│   └── Layout/
│       ├── AppLayout.tsx      ← 侧边栏 + 顶栏 + Outlet
│       └── Sidebar.tsx        ← 导航
├── pages/
│   ├── Dashboard/             ← 总览 (GPU + 请求统计)
│   ├── Services/              ← vLLM 服务管理
│   ├── ModelCenter/           ← 模型注册表
│   ├── ModelStore/            ← 模型商店
│   ├── ApiKeys/               ← API 密钥管理
│   ├── Settings/              ← 系统设置
│   ├── UserManagement/
│   └── Login/
├── stores/authStore.ts        ← 认证状态
├── services/api.ts            ← API 客户端 (自动 snake↔camel)
├── types/index.ts             ← TypeScript 类型
└── styles/global.css          ← CSS Variables
```

## API 客户端

```typescript
import { api, ApiError } from '../services/api';

// GET (自动带 JWT，自动 snake→camel)
const services = await api.get<LLMService[]>('/services');

// POST (自动 camel→snake)
await api.post('/services', { name: 'qwen', endpoint: 'http://...' });

// 错误处理
try { ... } catch (err) {
  if (err instanceof ApiError) console.error(err.status, err.detail);
}
```
