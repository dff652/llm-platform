#!/usr/bin/env bash
#
# 取消容器化部署的 API 调用频率限制
#
# 用法:
#   sudo bash scripts/disable-rate-limit.sh          # 取消限制
#   sudo bash scripts/disable-rate-limit.sh --show    # 查看当前限制
#   sudo bash scripts/disable-rate-limit.sh --reset   # 恢复默认限制 (10/100/500)
#
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# 自动查找容器名（支持任意部署目录和容器名前缀）
REDIS_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i redis | grep -i llm-platform | head -1 || echo "")
PG_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i postgres | grep -i llm-platform | head -1 || echo "")

# 回退：不带 llm-platform 前缀的也找
if [ -z "$REDIS_CONTAINER" ]; then
    REDIS_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i redis | head -1 || echo "")
fi
if [ -z "$PG_CONTAINER" ]; then
    PG_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1 || echo "")
fi

[ -z "$REDIS_CONTAINER" ] && error "未找到 Redis 容器，请确认 docker ps 能看到 Redis"
[ -z "$PG_CONTAINER" ] && error "未找到 PostgreSQL 容器，请确认 docker ps 能看到 PostgreSQL"

info "Redis 容器: $REDIS_CONTAINER"
info "PostgreSQL 容器: $PG_CONTAINER"

show() {
    echo ""
    echo "当前 API 调用频率限制:"
    result=$(docker exec "$REDIS_CONTAINER" redis-cli HGETALL "system:rate_limits" 2>/dev/null || echo "")
    if [ -z "$result" ]; then
        echo "  使用默认值: 10次/分钟, 100次/小时, 500次/天"
    else
        minute=$(docker exec "$REDIS_CONTAINER" redis-cli HGET "system:rate_limits" per_minute 2>/dev/null | tr -d '\r' || echo "?")
        hour=$(docker exec "$REDIS_CONTAINER" redis-cli HGET "system:rate_limits" per_hour 2>/dev/null | tr -d '\r' || echo "?")
        day=$(docker exec "$REDIS_CONTAINER" redis-cli HGET "system:rate_limits" per_day 2>/dev/null | tr -d '\r' || echo "?")
        echo "  每分钟: $minute"
        echo "  每小时: $hour"
        echo "  每天:   $day"
    fi
    echo ""
}

disable() {
    # 1. 系统默认限流（Redis）
    docker exec "$REDIS_CONTAINER" redis-cli HSET "system:rate_limits" \
        per_minute 999999 per_hour 999999 per_day 999999 >/dev/null 2>&1
    info "系统默认限流已取消"

    # 2. API Key 级别限流（数据库）
    docker exec "$PG_CONTAINER" psql -U llmuser -d llm_platform -c \
        "UPDATE api_keys SET rate_limit_per_minute=0, rate_limit_per_hour=0, rate_limit_per_day=0;" 2>/dev/null
    info "所有 API Key 限流已清零（使用系统默认值 999999）"

    # 3. 清除已有的限流计数器
    docker exec "$REDIS_CONTAINER" redis-cli --scan --pattern "ratelimit:*" 2>/dev/null | while read -r key; do
        docker exec "$REDIS_CONTAINER" redis-cli DEL "$key" >/dev/null 2>&1
    done
    info "已清除限流计数器缓存"

    show
}

reset_defaults() {
    docker exec "$REDIS_CONTAINER" redis-cli HSET "system:rate_limits" \
        per_minute 10 per_hour 100 per_day 500 >/dev/null 2>&1
    docker exec "$PG_CONTAINER" psql -U llmuser -d llm_platform -c \
        "UPDATE api_keys SET rate_limit_per_minute=0, rate_limit_per_hour=0, rate_limit_per_day=0;" 2>/dev/null
    info "API 频率限制已恢复默认值 (10/100/500)"
    show
}

case "${1:-}" in
    --show)   show ;;
    --reset)  reset_defaults ;;
    *)        disable ;;
esac
