#!/usr/bin/env bash
#
# 构建离线部署包
#
# 在构建机器上执行，产出 dist/llm-platform-offline.tar.gz
# 包含：所有 Docker 镜像 + 配置 + 脚本 + 测试数据 + 文档
#
# 用法:
#   ./scripts/build-offline.sh              # 构建 + 打包
#   ./scripts/build-offline.sh --skip-build  # 跳过构建，只打包（镜像已构建时）
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
DIST_DIR="$PROJECT_DIR/dist"
BUILD_DIR=$(mktemp -d)

# 镜像名称
IMG_FRONTEND="llm-platform/frontend:latest"
IMG_BACKEND="llm-platform/backend:latest"
IMG_POSTGRES="postgres:16-alpine"
IMG_REDIS="redis:7-alpine"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "${CYAN}[STEP]${NC} $*"; }

SKIP_BUILD=false
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=true

# 日志
mkdir -p "$PROJECT_DIR/logs"
LOG_FILE="$PROJECT_DIR/logs/build-offline_$(date +%Y%m%d_%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

# 确保异常退出时也能输出错误信息
trap 'echo -e "\n${RED}[ERROR]${NC} 构建在第 $LINENO 行异常退出，查看日志: $LOG_FILE" >&2' ERR

info "日志保存到: $LOG_FILE"

echo ""
echo "============================================================"
echo "  LLM-Platform 离线部署包构建"
echo "============================================================"
echo ""

# ─── Step 1: 检查依赖 ───

step "1/8 检查构建依赖..."

command -v docker >/dev/null || error "需要 Docker"
command -v docker compose version >/dev/null 2>&1 || docker compose version >/dev/null 2>&1 || error "需要 docker compose v2"

# 检查 ts_quality wheel（始终从源码重建以确保最新）
# sudo 下用 SUDO_USER 身份构建 wheel（避免 root 缺少 python build 模块）
if [ -d "/home/douff/ts_quality" ]; then
    info "从源码重建 ts_quality wheel..."
    rm -f docker/ts_quality-*.whl
    if [ -n "${SUDO_USER:-}" ]; then
        sudo -u "$SUDO_USER" bash -c 'cd /home/douff/ts_quality && ./build.sh source'
    else
        (cd /home/douff/ts_quality && ./build.sh source)
    fi
    cp /home/douff/ts_quality/dist/ts_quality-*.whl docker/
    info "ts_quality wheel 已更新"
elif ls docker/ts_quality-*.whl >/dev/null 2>&1; then
    warn "使用已有 ts_quality wheel: $(ls docker/ts_quality-*.whl)（无法从源码重建）"
else
    error "找不到 ts_quality 项目，也没有预构建的 wheel"
fi

info "依赖检查通过"

# ─── Step 2: 构建项目镜像 ───

if $SKIP_BUILD; then
    step "2/8 跳过构建（--skip-build）"
    docker image inspect "$IMG_BACKEND" >/dev/null 2>&1 || error "镜像 $IMG_BACKEND 不存在，请先构建"
    docker image inspect "$IMG_FRONTEND" >/dev/null 2>&1 || error "镜像 $IMG_FRONTEND 不存在，请先构建"
else
    step "2/8 构建前端..."
    # Build frontend on host (avoid Docker container network issues)
    if [ ! -d "frontend/dist" ] || [ "frontend/dist" -ot "frontend/src" ]; then
        (cd frontend && npm run build)
        info "前端构建完成"
    else
        info "前端 dist/ 已存在，跳过构建"
    fi

    step "3/8 构建 Docker 镜像..."
    BUILD_TIME=$(date '+%Y-%m-%d %H:%M') PG_PASSWORD=build docker compose build --build-arg BUILD_TIME="$(date '+%Y-%m-%d %H:%M')" frontend backend
    info "Docker 镜像构建完成"

    # 验证后端镜像关键依赖
    info "验证后端镜像依赖..."
    IMPORT_CHECK=$(docker run --rm "$IMG_BACKEND" python -c "
import fastapi, uvicorn, celery, redis, sqlalchemy, alembic
import httpx, pandas, numpy, scipy, sklearn, bcrypt, jwt
import sse_starlette
print('OK')
" 2>&1)
    if [ "$IMPORT_CHECK" = "OK" ]; then
        info "后端镜像依赖验证通过"
    else
        error "后端镜像缺少依赖:\n$IMPORT_CHECK"
    fi
fi

# ─── Step 3: 拉取官方镜像 ───

step "4/8 准备官方镜像..."
for img in "$IMG_POSTGRES" "$IMG_REDIS"; do
    if docker image inspect "$img" >/dev/null 2>&1; then
        info "  $img 已存在"
    else
        info "  拉取 $img ..."
        docker pull "$img"
    fi
done

# ─── Step 4: 导出所有镜像 ───

step "5/8 导出镜像..."
mkdir -p "$BUILD_DIR/llm-platform-offline/images"

info "  导出自建镜像..."
docker save "$IMG_FRONTEND" "$IMG_BACKEND" | gzip > "$BUILD_DIR/llm-platform-offline/images/llm-platform-images.tar.gz"

info "  导出 PostgreSQL..."
docker save "$IMG_POSTGRES" | gzip > "$BUILD_DIR/llm-platform-offline/images/postgres-16-alpine.tar.gz"

info "  导出 Redis..."
docker save "$IMG_REDIS" | gzip > "$BUILD_DIR/llm-platform-offline/images/redis-7-alpine.tar.gz"

# ─── Step 5: 打包 vLLM 环境（可选）───

step "6/8 打包 vLLM 环境..."
mkdir -p "$BUILD_DIR/llm-platform-offline"
VLLM_PKG="$BUILD_DIR/llm-platform-offline/vllm-env.tar.gz"

if [ -f "$DIST_DIR/vllm-env.tar.gz" ]; then
    info "vLLM 环境包已存在 ($(du -h "$DIST_DIR/vllm-env.tar.gz" | cut -f1))，使用缓存"
    cp "$DIST_DIR/vllm-env.tar.gz" "$VLLM_PKG"
else
    warn "vLLM 环境包不存在: $DIST_DIR/vllm-env.tar.gz"
    warn "请先以普通用户（非 sudo）执行 vLLM 打包脚本:"
    warn "  ./scripts/pack-vllm.sh"
    warn "打包完成后重新运行本脚本即可。跳过 vLLM 打包。"
fi

# ─── Step 6: 组装部署包 ───

step "7/8 组装部署包..."
PACK_DIR="$BUILD_DIR/llm-platform-offline"

# 配置
mkdir -p "$PACK_DIR/config"
cp docker-compose.yml "$PACK_DIR/config/"
cp .env.production "$PACK_DIR/config/.env.template"
cp docker/nginx.conf "$PACK_DIR/config/"

# 脚本
mkdir -p "$PACK_DIR/scripts"
cp scripts/offline/deploy.sh "$PACK_DIR/scripts/"
cp scripts/offline/check-env.sh "$PACK_DIR/scripts/"
cp scripts/offline/verify.sh "$PACK_DIR/scripts/"
cp scripts/offline/manage.sh "$PACK_DIR/scripts/"
cp scripts/offline/compose-compat.sh "$PACK_DIR/scripts/"
cp scripts/offline/start-vllm.sh "$PACK_DIR/scripts/"
cp scripts/offline/disable-rate-limit.sh "$PACK_DIR/scripts/"
cp backend/scripts/gpu_agent.py "$PACK_DIR/scripts/"
chmod +x "$PACK_DIR/scripts/"*.sh

# 测试 — SDK 样例
mkdir -p "$PACK_DIR/tests"
cp backend/tests/examples/analysis_request.json "$PACK_DIR/tests/test-data.json"
cp backend/tests/examples/client.py "$PACK_DIR/tests/sdk-client.py"

# 模型目录（空，由用户放入）
mkdir -p "$PACK_DIR/models"
echo "# 将模型文件放在此目录" > "$PACK_DIR/models/README.md"
echo "# 例如: Qwen3-VL-8B-Instruct/" >> "$PACK_DIR/models/README.md"

# 数据和日志目录
mkdir -p "$PACK_DIR/data" "$PACK_DIR/logs"

# README
cat > "$PACK_DIR/README.md" << 'HEREDOC'
# LLM-Platform 离线部署包

## 快速部署（4 步）

```bash
# 1. 解压
tar xzf llm-platform-offline.tar.gz
cd llm-platform-offline

# 2. 环境检测
sudo bash scripts/check-env.sh

# 3. 一键部署
sudo bash scripts/deploy.sh

# 4. 验证
sudo bash scripts/verify.sh
```

## 目录说明

```
llm-platform-offline/
├── images/          # Docker 镜像（离线加载）
├── config/          # 配置文件
├── scripts/         # 部署/运维脚本
├── tests/           # API 测试数据和客户端
├── models/          # GPU 模型文件（可选）
├── data/            # 运行时数据（自动生成）
└── logs/            # 日志目录
```

## 目标机器要求

- Docker 20+ / docker compose v2
- 4 核 CPU / 8 GB 内存（最低）
- 50 GB 磁盘空间
- GPU（可选，用于 AI 推理加速）

## 运维管理

```bash
sudo bash scripts/manage.sh           # 交互式菜单
sudo bash scripts/manage.sh status     # 查看状态
sudo bash scripts/manage.sh logs       # 查看日志
sudo bash scripts/manage.sh stop       # 停止
sudo bash scripts/manage.sh restart    # 重启
```

## 默认账号

- 用户名: admin
- 密码: 部署时设置
HEREDOC

# ─── Step 6: 打包 ───

step "8/8 打包..."
mkdir -p "$DIST_DIR"
PACK_FILE="$DIST_DIR/llm-platform-offline.tar.gz"
# 打包前校验必需文件
PACK_DIR="$BUILD_DIR/llm-platform-offline"
MISSING=0
for f in \
    config/docker-compose.yml \
    config/.env.template \
    config/nginx.conf \
    scripts/deploy.sh \
    scripts/check-env.sh \
    scripts/verify.sh \
    scripts/manage.sh \
    scripts/compose-compat.sh \
    scripts/start-vllm.sh \
    images/llm-platform-images.tar.gz \
    images/postgres-16-alpine.tar.gz \
    images/redis-7-alpine.tar.gz \
    README.md; do
    if [ ! -f "$PACK_DIR/$f" ]; then
        error_msg="  缺失: $f"
        echo -e "${RED}[MISS]${NC} $error_msg"
        MISSING=$((MISSING + 1))
    fi
done

if [ "$MISSING" -gt 0 ]; then
    error "部署包校验失败: $MISSING 个文件缺失，请检查构建过程"
fi

# 校验容器名一致性（docker-compose.yml vs verify.sh）
COMPOSE_CONTAINERS=$(grep container_name "$PACK_DIR/config/docker-compose.yml" 2>/dev/null | sed 's/.*: *//' | sort || true)
VERIFY_CONTAINERS=$(grep -oE 'llm-platform-[a-zA-Z0-9_]+' "$PACK_DIR/scripts/verify.sh" 2>/dev/null | sort -u || true)
for c in $VERIFY_CONTAINERS; do
    if ! echo "$COMPOSE_CONTAINERS" | grep -q "$c"; then
        warn "verify.sh 引用了容器 '$c'，但 docker-compose.yml 中未定义"
    fi
done

info "部署包校验通过"

tar czf "$PACK_FILE" -C "$BUILD_DIR" llm-platform-offline
rm -rf "$BUILD_DIR"

SIZE=$(du -h "$PACK_FILE" | cut -f1)
echo ""
echo "============================================================"
info "离线部署包已生成: $PACK_FILE ($SIZE)"
echo "============================================================"
echo ""
info "搬运到目标机器:"
echo "  scp $PACK_FILE user@target:/opt/"
echo ""
info "目标机器部署:"
echo "  cd /opt && tar xzf llm-platform-offline.tar.gz"
echo "  cd llm-platform-offline"
echo "  sudo bash scripts/deploy.sh"
echo ""
