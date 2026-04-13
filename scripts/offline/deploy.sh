#!/usr/bin/env bash
#
# 一键离线部署 TS-Platform
#
# 执行顺序: 环境检测 → 加载镜像 → 配置 → 启动 → 建表 → 验证
#
set -euo pipefail

cd "$(dirname "$0")/.."
DEPLOY_DIR=$(pwd)

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "\n${CYAN}[STEP]${NC} ${BOLD}$*${NC}"; }

# 日志
mkdir -p logs
LOG_FILE="logs/deploy_$(date +%Y%m%d_%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "============================================================"
echo "  TS-Platform 离线部署"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"
echo ""
info "日志保存到: $LOG_FILE"

# docker compose 兼容（支持 standalone docker-compose）
source "$(dirname "$0")/compose-compat.sh"

# ─── Step 1: 环境检测 ───

step "1/7 环境检测"
if bash scripts/check-env.sh; then
    info "环境检测通过"
else
    error "环境检测未通过，请先修复问题"
fi

# ─── Step 2: 加载镜像 ───

step "2/7 加载 Docker 镜像"
for tarfile in images/*.tar.gz; do
    name=$(basename "$tarfile" .tar.gz)
    info "  加载 $name ..."
    docker load < "$tarfile"
done
info "镜像加载完成"
docker images --format "  {{.Repository}}:{{.Tag}}\t{{.Size}}" | grep -E "ts-platform|postgres|redis" || true

# 校验必需镜像
for img in "ts-platform/frontend:latest" "ts-platform/backend:latest" "postgres:16-alpine" "redis:7-alpine"; do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
        error "镜像 $img 加载失败"
    fi
done
info "4 个镜像校验通过"

# ─── Step 3: 配置 ───

step "3/7 配置"
if [ ! -f ".env" ]; then
    cp config/.env.template .env
    info "已创建 .env（从模板复制）"

    # 交互式配置
    echo ""
    echo -e "${BOLD}请设置以下配置（回车使用默认值）：${NC}"
    echo ""

    # PostgreSQL 密码
    read -rp "  PostgreSQL 密码 [tspass123]: " pg_pass
    pg_pass=${pg_pass:-tspass123}
    sed -i "s/PG_PASSWORD=.*/PG_PASSWORD=$pg_pass/" .env

    # JWT Secret
    jwt_secret=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)
    sed -i "s/JWT_SECRET=.*/JWT_SECRET=$jwt_secret/" .env
    info "  JWT_SECRET 已自动生成"

    # Admin 密码
    read -rp "  管理员密码 [admin123]: " admin_pass
    admin_pass=${admin_pass:-admin123}
    sed -i "s/SEED_ADMIN_PASSWORD=.*/SEED_ADMIN_PASSWORD=$admin_pass/" .env

    # 端口（被占用的会标注提示）
    _port_hint() {
        if ss -tlnp 2>/dev/null | grep -q ":$1 "; then
            echo " ← 已被占用，建议更换"
        fi
    }

    read -rp "  前端端口 [3000]$(_port_hint 3000): " fe_port
    fe_port=${fe_port:-3000}
    sed -i "s/FRONTEND_PORT=.*/FRONTEND_PORT=$fe_port/" .env

    read -rp "  后端端口 [8100]$(_port_hint 8100): " be_port
    be_port=${be_port:-8100}
    sed -i "s/API_PORT=.*/API_PORT=$be_port/" .env

    read -rp "  PostgreSQL 端口 [5432]$(_port_hint 5432): " pg_port
    pg_port=${pg_port:-5432}
    sed -i "s/PG_PORT=.*/PG_PORT=$pg_port/" .env

    read -rp "  Redis 端口 [6380]$(_port_hint 6380): " redis_port
    redis_port=${redis_port:-6380}
    sed -i "s/REDIS_PORT=.*/REDIS_PORT=$redis_port/" .env

    echo ""
    info "配置已保存到 .env"
else
    info ".env 已存在，跳过配置"
fi

# 复制 compose 文件
cp config/docker-compose.yml .
info "docker-compose.yml 已就绪"

# ─── Step 4: 启动服务 ───

step "4/7 启动服务"
docker compose up -d
info "等待服务就绪..."

# 等 PostgreSQL 就绪
for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U tsuser >/dev/null 2>&1; then
        info "PostgreSQL 就绪"
        break
    fi
    if [ "$i" -eq 30 ]; then
        error "PostgreSQL 启动超时"
    fi
    sleep 1
done

# 等后端就绪
be_port=$(grep API_PORT .env 2>/dev/null | cut -d= -f2 || echo 8100)
for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${be_port}/api/v1/auth/me" 2>/dev/null || echo "000")
    if [ "$code" != "000" ]; then
        info "后端就绪"
        break
    fi
    if [ "$i" -eq 30 ]; then
        error "后端启动超时，查看日志: docker compose logs backend"
    fi
    sleep 2
done

# ─── Step 5: 初始化数据库 ───

step "5/7 初始化数据库"
# seed.py 内部用 Base.metadata.create_all 建表（比 alembic migration 更可靠）
# 然后 alembic stamp head 标记为最新版本
docker compose exec -T backend bash -c "cd /app && PYTHONPATH=/app python -m scripts.seed" || warn "seed 可能已执行过"
docker compose exec -T backend bash -c "cd /app && PYTHONPATH=/app alembic stamp head" 2>/dev/null || warn "alembic stamp 跳过"
info "数据库初始化完成"

# 提取 API Key 文件到宿主机
docker compose cp backend:/app/data/api_keys.json ./data/api_keys.json 2>/dev/null \
    && info "API Key 已保存到 data/api_keys.json" \
    || warn "API Key 文件提取失败（可能已存在或 seed 跳过了生成）"

# ─── Step 6: 启动 GPU Agent ───

step "6/8 启动 GPU Agent"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    # 检查是否已在运行
    if pgrep -f "gpu_agent.py" >/dev/null 2>&1; then
        info "GPU Agent 已在运行"
    else
        # 找到 backend 源码中的 gpu_agent.py（从镜像中提取或使用部署包自带的）
        AGENT_SCRIPT=""
        if [ -f "$DEPLOY_DIR/scripts/gpu_agent.py" ]; then
            AGENT_SCRIPT="$DEPLOY_DIR/scripts/gpu_agent.py"
        else
            # 从 backend 镜像提取
            docker compose cp backend:/app/scripts/gpu_agent.py "$DEPLOY_DIR/scripts/gpu_agent.py" 2>/dev/null || true
            if [ -f "$DEPLOY_DIR/scripts/gpu_agent.py" ]; then
                AGENT_SCRIPT="$DEPLOY_DIR/scripts/gpu_agent.py"
            fi
        fi

        if [ -n "$AGENT_SCRIPT" ]; then
            VLLM_ENV_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"
            AGENT_PYTHON="${VLLM_ENV_DIR}/bin/python3"
            if [ ! -f "$AGENT_PYTHON" ]; then
                warn "vLLM Python 不存在 ($AGENT_PYTHON)，请先安装 vLLM 环境"
            else
                GPU_AGENT_PORT=$(grep GPU_AGENT_PORT .env 2>/dev/null | cut -d= -f2 || echo "9100")
                mkdir -p "$DEPLOY_DIR/logs"
                nohup "$AGENT_PYTHON" "$AGENT_SCRIPT" --port "$GPU_AGENT_PORT" > "$DEPLOY_DIR/logs/gpu-agent.log" 2>&1 &
                info "GPU Agent 已启动 (PID=$!, 端口=$GPU_AGENT_PORT)"
            fi
        else
            warn "未找到 gpu_agent.py，GPU 监控和模型管理将不可用"
        fi
    fi
else
    info "未检测到 GPU，跳过 GPU Agent"
fi

# ─── Step 7: 验证 ───

step "7/8 部署验证"
if [ -f "scripts/verify.sh" ]; then
    bash scripts/verify.sh
else
    # 简单验证
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${be_port}/api/v1/auth/me" 2>/dev/null)
    if [ "$code" = "401" ]; then
        info "API 响应正常 (HTTP 401)"
    else
        warn "API 响应异常: HTTP $code"
    fi
fi

# ─── Step 8: 完成 ───

step "8/8 部署完成"

fe_port=$(grep FRONTEND_PORT .env 2>/dev/null | cut -d= -f2 || echo 3000)
be_port=$(grep API_PORT .env 2>/dev/null | cut -d= -f2 || echo 8100)
admin_pass=$(grep SEED_ADMIN_PASSWORD .env 2>/dev/null | cut -d= -f2 || echo admin123)

echo ""
echo "============================================================"
echo -e "  ${GREEN}${BOLD}TS-Platform 部署成功${NC}"
echo "============================================================"
echo ""
echo "  前端地址:  http://localhost:${fe_port}"
echo "  后端 API:  http://localhost:${be_port}"
echo "  管理员:    admin / ${admin_pass}"
echo ""
echo "  运维管理:  sudo bash scripts/manage.sh"
echo "  查看日志:  docker compose logs -f"
echo "  部署日志:  $LOG_FILE"
echo ""
echo "  验收测试:  /opt/vllm-env/bin/python3 ../tests/run_acceptance.py --csv ../tests/tep_data_1year.csv --method qwen --url http://localhost:${be_port}"
echo ""
