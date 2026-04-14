#!/usr/bin/env bash
#
# 部署后验证 — 检查所有服务是否正常运行
#
set -euo pipefail

cd "$(dirname "$0")/.."

# docker compose 兼容（支持 standalone docker-compose）
source "$(dirname "$0")/compose-compat.sh"

VLLM_ENV_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"

# Python: 优先 vLLM 环境，fallback 系统 python3
if [ -f "$VLLM_ENV_DIR/bin/python3" ]; then
    PY3="$VLLM_ENV_DIR/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
    PY3="python3"
else
    PY3=""
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}[PASS]${NC} $*"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $*"; ERRORS=$((ERRORS + 1)); }

ERRORS=0

# 读配置
BE_PORT=$(grep API_PORT .env 2>/dev/null | cut -d= -f2 || echo 8100)
FE_PORT=$(grep FRONTEND_PORT .env 2>/dev/null | cut -d= -f2 || echo 3000)
ADMIN_PASS=$(grep SEED_ADMIN_PASSWORD .env 2>/dev/null | cut -d= -f2 || echo admin123)

echo ""
echo "============================================================"
echo "  LLM-Platform 部署验证"
echo "============================================================"
echo ""

# ─── 容器状态 ───
echo "容器状态:"
for svc in frontend backend celery postgres redis; do
    container="llm-platform-$svc"
    status=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "not found")
    if [ "$status" = "running" ]; then
        pass "$container: running"
    else
        fail "$container: $status"
    fi
done

# ─── 服务连通 ───
echo ""
echo "服务连通:"

# 后端 API
code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${BE_PORT}/api/v1/auth/me" 2>/dev/null || echo "000")
if [ "$code" = "401" ]; then
    pass "后端 API (HTTP 401 — 正常，需要认证)"
else
    fail "后端 API (HTTP $code)"
fi

# 前端
code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${FE_PORT}/" 2>/dev/null || echo "000")
if [ "$code" = "200" ]; then
    pass "前端页面 (HTTP 200)"
else
    fail "前端页面 (HTTP $code)"
fi

# PostgreSQL
if docker compose exec -T postgres pg_isready -U llmuser >/dev/null 2>&1; then
    pass "PostgreSQL 连接正常"
else
    fail "PostgreSQL 连接失败"
fi

# Redis
if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    pass "Redis 连接正常"
else
    fail "Redis 连接失败"
fi

# ─── API 功能验证 ───
echo ""
echo "API 功能:"

# 登录
TOKEN=$(curl -s "http://localhost:${BE_PORT}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASS}\"}" 2>/dev/null | \
    $PY3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -n "$TOKEN" ]; then
    pass "管理员登录成功"
else
    fail "管理员登录失败（密码: $ADMIN_PASS）"
fi

if [ -n "$TOKEN" ]; then
    AUTH="Authorization: Bearer $TOKEN"

    # 查算法列表
    algos=$(curl -s "http://localhost:${BE_PORT}/api/v1/inference/methods" -H "$AUTH" 2>/dev/null)
    count=$(echo "$algos" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
    if [ "$count" -gt 0 ]; then
        pass "算法列表: $count 个可用"
    else
        fail "算法列表为空"
    fi

    # 查引擎状态
    services=$(curl -s "http://localhost:${BE_PORT}/api/v1/inference/services" -H "$AUTH" 2>/dev/null)
    svc_count=$(echo "$services" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo 0)
    if [ "$svc_count" -gt 0 ]; then
        pass "推理引擎: $svc_count 个已注册"
    else
        warn "推理引擎: 0 个（需要在引擎管理页注册）"
    fi

    # 查 Dashboard（gpu-stats 是实际存在的端点）
    dash=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${BE_PORT}/api/v1/dashboard/gpu-stats" -H "$AUTH" 2>/dev/null)
    if [ "$dash" = "200" ]; then
        pass "Dashboard API 正常"
    else
        fail "Dashboard API (HTTP $dash)"
    fi
fi

# ─── 数据库 Migration ───
echo ""
echo "数据库:"
migration_output=$(docker compose exec -T backend bash -c "cd /app && PYTHONPATH=/app alembic current" 2>&1 || echo "error")
if echo "$migration_output" | grep -q "head"; then
    pass "数据库 migration 已到最新版本"
else
    fail "数据库 migration 不是最新（运行: docker compose exec backend alembic upgrade head）"
fi

# ─── Celery Worker ───
echo ""
echo "任务队列:"
celery_status=$(docker compose exec -T celery-worker celery -A app.core.celery_app inspect ping 2>&1 || echo "error")
if echo "$celery_status" | grep -q "pong"; then
    pass "Celery worker 响应正常"
else
    warn "Celery worker 未响应（异步任务可能不可用）"
fi

# ─── GPU / vLLM（可选）───
echo ""
echo "GPU 推理（可选）:"
if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_info=$(nvidia-smi --query-gpu=name,memory.free --format=csv,noheader 2>/dev/null | head -1)
    pass "GPU 可用: $gpu_info"
else
    warn "未检测到 GPU"
fi

# VLLM_ENV_DIR 已在顶部定义
if [ -d "$VLLM_ENV_DIR/bin" ]; then
    vllm_ver=$("$VLLM_ENV_DIR/bin/python3" -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "")
    if [ -n "$vllm_ver" ]; then
        pass "vLLM $vllm_ver 已安装"
    else
        fail "vLLM 环境异常"
    fi
else
    warn "vLLM 未安装（GPU 推理不可用）"
fi

# ─── 结果 ───
echo ""
echo "============================================================"
if [ "$ERRORS" -eq 0 ]; then
    echo -e "  ${GREEN}所有验证通过${NC}"
    echo ""
    echo "  访问: http://localhost:${FE_PORT}"
    echo "  账号: admin / ${ADMIN_PASS}"
else
    echo -e "  ${RED}$ERRORS 项验证失败${NC}"
    echo "  查看日志: docker compose logs"
fi
echo "============================================================"
echo ""

exit "$ERRORS"
