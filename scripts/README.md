# 脚本索引

## 发版

发版脚本统一放在 ts_quality 项目中（跨项目管理）：

```bash
cd /home/douff/ts_quality
./scripts/release.sh status          # 查看当前版本
./scripts/release.sh check           # 一致性巡检
./scripts/release.sh tsq 0.6.0      # 发布 ts_quality
./scripts/release.sh platform 1.5.0 # 发布 ts-platform
```

## 构建

| 脚本 | 用途 | 产物 |
|------|------|------|
| `build-offline.sh` | 构建完整离线部署包 | `dist/ts-platform-offline.tar.gz` |
| `pack-vllm.sh` | 打包 vLLM GPU 环境 | `dist/vllm-env.tar.gz` |
| `deploy-test.sh build` | 仅构建 Docker 镜像 | 本地 Docker 镜像 |
| `deploy-test.sh export` | 构建 + 导出镜像 | `dist/ts-platform-images.tar.gz` |
| `deploy-test.sh pack` | 构建 + 导出 + 打包部署包 | `dist/ts-platform-deploy.tar.gz` |

## 部署

| 脚本 | 用途 | 运行位置 |
|------|------|----------|
| `deploy-test.sh deploy` | 构建+部署一体 | 构建机 = 部署机 |
| `deploy-test.sh start` | 从已有镜像启动 | 目标机器 |
| `deploy-test.sh import` | 加载离线镜像 | 目标机器 |
| `prepare-deploy.sh` | rsync 部署包到远程 | 构建机 |
| `offline/deploy.sh` | 离线一键部署 | 目标机器（无网络） |
| `offline/manage.sh` | 运维管理菜单 | 目标机器 |
| `offline/verify.sh` | 部署后验证 | 目标机器 |
| `offline/check-env.sh` | 环境检测 | 目标机器 |
| `offline/start-vllm.sh` | 启动 vLLM GPU 服务 | GPU 机器 |

## 开发

| 脚本 | 用途 |
|------|------|
| `dev.sh` | 启动后端开发服务 (uvicorn + celery) |
| `tmux-start.sh` | tmux 多窗口启动前后端 |
| `watch-frontend.sh` | 前端热重载监控 |
| `healthcheck.sh` | 健康检查 |

## 典型流程

```
发版 → 构建 → 部署

./release.sh tsq 0.6.0                    # 1. 发版
./release.sh platform 1.5.0
./release.sh check                         # 2. 验证

cd ts-platform
./scripts/deploy-test.sh pack              # 3. 构建打包
scp dist/ts-platform-deploy.tar.gz target: # 4. 传输

ssh target
./scripts/deploy-test.sh start             # 5. 部署
```
