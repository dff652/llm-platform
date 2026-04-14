#!/usr/bin/env bash
#
# LLM-Platform 部署后健康检查
#
set -euo pipefail

cd "$(dirname "$0")/.."

# 读取端口配置
ENV_FILE=".env.test"
if [ -f "$ENV_FILE" ]; then
    API_PORT=$(grep API_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    FRONTEND_PORT=$(grep FRONTEND_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
fi
API_PORT=${API_PORT:-8200}
FRONTEND_PORT=${FRONTEND_PORT:-3100}

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0
fail=0
warn_count=0

check() {
    local name="$1" url="$2" expect="$3"
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 5 2>/dev/null || echo "000")
    if [ "$code" = "$expect" ]; then
        echo -e "  ${GREEN}✓${NC} $name (HTTP $code)"
        ((pass++))
    else
        echo -e "  ${RED}✗${NC} $name (期望 HTTP $expect, 实际 $code)"
        ((fail++))
    fi
}

check_container() {
    local name="$1"
    local status
    status=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo "not_found")
    if [ "$status" = "running" ]; then
        echo -e "  ${GREEN}✓${NC} 容器 $name 运行中"
        ((pass++))
    else
        echo -e "  ${RED}✗${NC} 容器 $name 状态: $status"
        ((fail++))
    fi
}

echo ""
echo -e "${BOLD}LLM-Platform 健康检查${NC}"
echo ""

# 1. 容器状态
echo -e "${BOLD}[容器状态]${NC}"
check_container "llm-platform-backend"
check_container "llm-platform-frontend"
check_container "llm-platform-postgres"
check_container "llm-platform-redis"
check_container "llm-platform-celery"
echo ""

# 2. API 端点
echo -e "${BOLD}[API 端点]${NC} (后端 :${API_PORT})"
check "登录接口" "http://localhost:${API_PORT}/api/v1/auth/me" "401"
check "算法列表" "http://localhost:${API_PORT}/api/v1/inference/methods" "401"
check "OpenAPI 文档" "http://localhost:${API_PORT}/docs" "200"
echo ""

# 3. 前端
echo -e "${BOLD}[前端页面]${NC} (前端 :${FRONTEND_PORT})"
check "前端首页" "http://localhost:${FRONTEND_PORT}/" "200"
echo ""

# 4. 数据库连通
echo -e "${BOLD}[数据库]${NC}"
local_pg_check=$(docker exec llm-platform-postgres pg_isready -U llmuser 2>/dev/null && echo "ok" || echo "fail")
if [ "$local_pg_check" = "ok" ]; then
    echo -e "  ${GREEN}✓${NC} PostgreSQL 连通"
    ((pass++))
else
    echo -e "  ${RED}✗${NC} PostgreSQL 不可达"
    ((fail++))
fi

local_redis_check=$(docker exec llm-platform-redis redis-cli ping 2>/dev/null || echo "fail")
if [ "$local_redis_check" = "PONG" ]; then
    echo -e "  ${GREEN}✓${NC} Redis 连通"
    ((pass++))
else
    echo -e "  ${RED}✗${NC} Redis 不可达"
    ((fail++))
fi
echo ""

# 5. 登录测试
echo -e "${BOLD}[功能验证]${NC}"
login_resp=$(curl -s -X POST "http://localhost:${API_PORT}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"admin123"}' --max-time 5 2>/dev/null || echo "{}")
if echo "$login_resp" | grep -q "access_token"; then
    echo -e "  ${GREEN}✓${NC} 管理员登录成功"
    ((pass++))
else
    echo -e "  ${YELLOW}⚠${NC} 管理员登录失败（可能密码已修改或 seed 未执行）"
    ((warn_count++))
fi
echo ""

# 汇总
echo -e "${BOLD}[结果]${NC} 通过: ${GREEN}${pass}${NC}, 失败: ${RED}${fail}${NC}, 警告: ${YELLOW}${warn_count}${NC}"
echo ""

if [ "$fail" -gt 0 ]; then
    echo -e "${RED}部署存在问题，请检查日志: docker compose logs${NC}"
    exit 1
else
    echo -e "${GREEN}部署正常!${NC}"
    exit 0
fi
