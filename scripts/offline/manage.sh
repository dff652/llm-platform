#!/usr/bin/env bash
#
# 运维管理脚本
#
# 用法:
#   sudo bash scripts/manage.sh              # 交互式菜单
#   sudo bash scripts/manage.sh status       # 查看状态
#   sudo bash scripts/manage.sh logs         # 查看日志
#   sudo bash scripts/manage.sh stop         # 停止
#   sudo bash scripts/manage.sh restart      # 重启
#   sudo bash scripts/manage.sh backup       # 备份数据库
#
set -euo pipefail

cd "$(dirname "$0")/.."
DEPLOY_DIR=$(pwd)

# docker compose 兼容（支持 standalone docker-compose）
source "$(dirname "$0")/compose-compat.sh"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }

cmd_status() {
    echo ""
    docker compose ps
    echo ""

    FE_PORT=$(grep FRONTEND_PORT .env 2>/dev/null | cut -d= -f2 || echo 3000)
    BE_PORT=$(grep API_PORT .env 2>/dev/null | cut -d= -f2 || echo 8100)
    echo "  前端: http://localhost:${FE_PORT}"
    echo "  API:  http://localhost:${BE_PORT}"
    echo ""
}

cmd_logs() {
    local svc="${1:-}"
    if [ -n "$svc" ]; then
        docker compose logs -f --tail=50 "$svc"
    else
        docker compose logs -f --tail=50
    fi
}

cmd_stop() {
    info "停止所有服务..."
    # 停容器前 disable GPU 引擎（容器停了 API 就不可用了）
    _disable_gpu_engines
    docker compose stop
    info "已停止"
}

_disable_gpu_engines() {
    local _port=$(grep API_PORT .env 2>/dev/null | cut -d= -f2 || echo "8100")
    local _pass=$(grep SEED_ADMIN_PASSWORD .env 2>/dev/null | cut -d= -f2 || echo "admin123")
    local _token=$(curl -s "http://localhost:$_port/api/v1/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"admin\",\"password\":\"$_pass\"}" 2>/dev/null \
        | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")
    [ -z "$_token" ] && return
    local _ids=$(curl -s "http://localhost:$_port/api/v1/inference/services" \
        -H "Authorization: Bearer $_token" 2>/dev/null \
        | python3 -c "
import sys, json
d = json.loads(sys.stdin.read() or '{}')
for s in d.get('items',[]):
    if s['service_type'] == 'gpu' and s.get('status') == 'enabled':
        print(s['id'])
" 2>/dev/null)
    for _id in $_ids; do
        curl -s -X PUT "http://localhost:$_port/api/v1/inference/services/$_id" \
            -H "Authorization: Bearer $_token" \
            -H "Content-Type: application/json" \
            -d '{"status":"disabled"}' >/dev/null 2>&1
        info "已禁用 GPU 引擎 (id=$_id)"
    done
}

cmd_start() {
    info "启动所有服务..."
    docker compose up -d
    info "已启动"
    cmd_status
}

cmd_restart() {
    cmd_stop
    sleep 2
    cmd_start
}

cmd_port() {
    if [ ! -f ".env" ]; then
        error ".env 不存在，请先运行 deploy.sh"
    fi

    _port_hint() {
        if ss -tlnp 2>/dev/null | grep -q ":$1 "; then
            echo " ← 已被占用"
        fi
    }

    # 读当前值
    CUR_FE=$(grep FRONTEND_PORT .env | cut -d= -f2)
    CUR_BE=$(grep API_PORT .env | cut -d= -f2)
    CUR_PG=$(grep PG_PORT .env | cut -d= -f2)
    CUR_REDIS=$(grep REDIS_PORT .env | cut -d= -f2)

    echo ""
    echo -e "${BOLD}修改端口（回车保持当前值）:${NC}"
    echo ""
    read -rp "  前端端口 [$CUR_FE]$(_port_hint "$CUR_FE"): " fe
    read -rp "  后端端口 [$CUR_BE]$(_port_hint "$CUR_BE"): " be
    read -rp "  PostgreSQL 端口 [$CUR_PG]$(_port_hint "$CUR_PG"): " pg
    read -rp "  Redis 端口 [$CUR_REDIS]$(_port_hint "$CUR_REDIS"): " redis

    CHANGED=false
    [ -n "$fe" ] && [ "$fe" != "$CUR_FE" ] && { sed -i "s/FRONTEND_PORT=.*/FRONTEND_PORT=$fe/" .env; CHANGED=true; }
    [ -n "$be" ] && [ "$be" != "$CUR_BE" ] && { sed -i "s/API_PORT=.*/API_PORT=$be/" .env; CHANGED=true; }
    [ -n "$pg" ] && [ "$pg" != "$CUR_PG" ] && { sed -i "s/PG_PORT=.*/PG_PORT=$pg/" .env; CHANGED=true; }
    [ -n "$redis" ] && [ "$redis" != "$CUR_REDIS" ] && { sed -i "s/REDIS_PORT=.*/REDIS_PORT=$redis/" .env; CHANGED=true; }

    if $CHANGED; then
        info "端口已更新，重启服务..."
        docker compose down 2>/dev/null || true
        docker compose up -d
        info "重启完成"
        cmd_status
    else
        info "端口未变更"
    fi
}

cmd_backup() {
    mkdir -p backups
    BACKUP_FILE="backups/db_$(date +%Y%m%d_%H%M%S).sql.gz"
    PG_USER=$(grep PG_USER .env 2>/dev/null | cut -d= -f2 || echo tsuser)
    PG_DB=$(grep PG_DB .env 2>/dev/null | cut -d= -f2 || echo ts_platform)

    info "备份数据库到 $BACKUP_FILE ..."
    docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$BACKUP_FILE"
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    info "备份完成: $BACKUP_FILE ($SIZE)"
}

cmd_restore() {
    local file="${1:-}"
    if [ -z "$file" ]; then
        echo "用法: $0 restore <backup_file.sql.gz>"
        ls backups/*.sql.gz 2>/dev/null || echo "  无备份文件"
        return
    fi
    if [ ! -f "$file" ]; then
        echo "文件不存在: $file"
        return
    fi

    PG_USER=$(grep PG_USER .env 2>/dev/null | cut -d= -f2 || echo tsuser)
    PG_DB=$(grep PG_DB .env 2>/dev/null | cut -d= -f2 || echo ts_platform)

    warn "将覆盖现有数据库 $PG_DB，确认?"
    read -rp "输入 yes 确认: " confirm
    if [ "$confirm" != "yes" ]; then
        info "已取消"
        return
    fi

    info "恢复数据库..."
    gunzip -c "$file" | docker compose exec -T postgres psql -U "$PG_USER" "$PG_DB"
    info "恢复完成"
}

cmd_down() {
    warn "将停止并删除所有容器和数据卷！"
    read -rp "确认? [y/N] " confirm
    if [[ "$confirm" =~ ^[yY]$ ]]; then
        docker compose down -v
        info "已清理"
    else
        info "已取消"
    fi
}

cmd_reset() {
    PARENT_DIR=$(dirname "$DEPLOY_DIR")

    echo ""
    echo -e "  ${RED}${BOLD}环境重置${NC}"
    echo ""
    warn "将清除: 容器+数据卷、vLLM 环境+进程、部署配置"
    warn "保留:   离线包、模型文件、测试数据"
    echo ""
    read -rp "确认重置? 输入 yes 继续: " confirm
    if [ "$confirm" != "yes" ]; then
        info "已取消"
        return
    fi

    # 停止 vLLM 并释放显存
    echo ""
    info "[1/5] 停止 vLLM 并释放 GPU 显存..."
    # 杀掉所有 vLLM 相关进程（主进程 + EngineCore 子进程）
    VLLM_PIDS=$(pgrep -f "vllm.entrypoints" 2>/dev/null || echo "")
    if [ -n "$VLLM_PIDS" ]; then
        echo "$VLLM_PIDS" | xargs kill 2>/dev/null || true
        sleep 3
        # 强制杀残留
        VLLM_PIDS=$(pgrep -f "vllm.entrypoints" 2>/dev/null || echo "")
        if [ -n "$VLLM_PIDS" ]; then
            echo "$VLLM_PIDS" | xargs kill -9 2>/dev/null || true
            sleep 2
        fi
        info "vLLM 进程已停止"
    else
        info "vLLM 未在运行"
    fi

    # 确保 GPU 显存释放
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
        # 杀掉所有占用 GPU 的残留 python 进程（vLLM 子进程可能没被 pgrep 到）
        GPU_PIDS=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | sort -u || echo "")
        if [ -n "$GPU_PIDS" ]; then
            warn "GPU 上仍有进程，强制释放..."
            echo "$GPU_PIDS" | xargs kill -9 2>/dev/null || true
            sleep 2
        fi
        GPU_MEM_USED=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "?")
        info "GPU 显存占用: ${GPU_MEM_USED}MiB"
    fi

    # 停止容器
    info "[2/5] 停止容器并清除数据..."
    docker compose down -v 2>/dev/null || true
    docker rmi ts-platform/frontend:latest ts-platform/backend:latest 2>/dev/null || true
    info "容器和镜像已清除"

    # 清除 vLLM 环境
    info "[3/5] 清除 vLLM 环境..."
    VLLM_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"
    rm -rf "$VLLM_DIR"
    info "$VLLM_DIR 已删除"

    # 清除解压目录和非交付文件
    info "[4/5] 清除部署目录和残留文件..."

    # 交付文件清单（只保留这些）
    # PARENT_DIR/ts-platform-offline.tar.gz
    # PARENT_DIR/DEPLOY-GUIDE.md
    # PARENT_DIR/models/
    # PARENT_DIR/tests/
    # 其他全部删除

    # 删除解压后的部署目录
    rm -rf "$DEPLOY_DIR"
    cd "$PARENT_DIR"
    info "部署目录 $DEPLOY_DIR 已删除"

    # 删除根目录下的非交付文件（旧的 vllm-env.tar.gz 等残留）
    for f in "$PARENT_DIR"/*; do
        fname=$(basename "$f")
        case "$fname" in
            ts-platform-offline.tar.gz|DEPLOY-GUIDE.md|models|tests)
                # 交付文件，保留
                ;;
            *)
                rm -rf "$f"
                info "  已删除: $fname"
                ;;
        esac
    done

    # 验证
    info "[5/5] 验证清理结果..."
    CLEAN=true
    RUNNING=$(docker ps --format "{{.Names}}" 2>/dev/null | grep "ts-platform" || echo "")
    [ -z "$RUNNING" ] && echo -e "  ${GREEN}[OK]${NC} 无 ts-platform 容器" || { warn "仍有容器: $RUNNING"; CLEAN=false; }
    ! pgrep -f "vllm.entrypoints" >/dev/null 2>&1 && echo -e "  ${GREEN}[OK]${NC} 无 vLLM 进程" || { warn "vLLM 仍在运行"; CLEAN=false; }
    [ ! -d "$VLLM_DIR" ] && echo -e "  ${GREEN}[OK]${NC} vLLM 环境已清除" || { warn "$VLLM_DIR 仍存在"; CLEAN=false; }
    [ ! -d "$DEPLOY_DIR" ] && echo -e "  ${GREEN}[OK]${NC} 部署目录已清除" || { warn "$DEPLOY_DIR 仍存在"; CLEAN=false; }

    # 确认保留的交付文件
    echo ""
    info "保留的交付文件:"
    [ -f "$PARENT_DIR/ts-platform-offline.tar.gz" ] && echo -e "  ${GREEN}[OK]${NC} ts-platform-offline.tar.gz" || warn "离线包缺失!"
    [ -f "$PARENT_DIR/DEPLOY-GUIDE.md" ] && echo -e "  ${GREEN}[OK]${NC} DEPLOY-GUIDE.md"
    [ -d "$PARENT_DIR/models" ] && echo -e "  ${GREEN}[OK]${NC} models/ ($(du -sh "$PARENT_DIR/models" 2>/dev/null | cut -f1))"
    [ -d "$PARENT_DIR/tests" ] && echo -e "  ${GREEN}[OK]${NC} tests/"

    echo ""
    if $CLEAN; then
        info "环境已重置，重新部署:"
        echo "  cd $PARENT_DIR"
        echo "  tar xzf ts-platform-offline.tar.gz"
        echo "  cd ts-platform-offline"
        echo "  sudo bash scripts/start-vllm.sh --install"
        echo "  sudo bash scripts/deploy.sh"
        echo "  sudo bash scripts/start-vllm.sh --start"
    else
        warn "清理不完全，请手动检查"
    fi

    # 部署目录已删除，脚本本身不存在了，必须退出
    exit 0
}

cmd_ratelimit() {
    local action="${1:-}"

    # 查找容器
    local REDIS_C=$(docker compose ps --format '{{.Name}}' 2>/dev/null | grep -i redis | head -1 || echo "")
    local PG_C=$(docker compose ps --format '{{.Name}}' 2>/dev/null | grep -i postgres | head -1 || echo "")
    [ -z "$REDIS_C" ] && { warn "未找到 Redis 容器"; return; }
    [ -z "$PG_C" ] && { warn "未找到 PostgreSQL 容器"; return; }

    _rl_show() {
        echo ""
        echo -e "${BOLD}  当前 API 限流配置:${NC}"
        local minute=$(docker exec "$REDIS_C" redis-cli HGET "system:rate_limits" per_minute 2>/dev/null | tr -d '\r')
        local hour=$(docker exec "$REDIS_C" redis-cli HGET "system:rate_limits" per_hour 2>/dev/null | tr -d '\r')
        local day=$(docker exec "$REDIS_C" redis-cli HGET "system:rate_limits" per_day 2>/dev/null | tr -d '\r')
        if [ -z "$minute" ]; then
            echo "  使用代码默认值: 10次/分钟, 100次/小时, 500次/天"
        else
            echo "  每分钟: $minute  每小时: $hour  每天: $day"
            [ "$minute" = "-1" ] && echo -e "  ${GREEN}(不限制)${NC}"
        fi
        echo ""
    }

    _rl_disable() {
        docker exec "$REDIS_C" redis-cli HSET "system:rate_limits" \
            per_minute -1 per_hour -1 per_day -1 >/dev/null 2>&1
        docker exec "$PG_C" psql -U tsuser -d ts_platform -c \
            "UPDATE system_configs SET value='-1' WHERE key IN ('rate_limit_per_minute','rate_limit_per_hour','rate_limit_per_day');" 2>/dev/null
        docker exec "$PG_C" psql -U tsuser -d ts_platform -c \
            "UPDATE api_keys SET rate_limit_per_minute=0, rate_limit_per_hour=0, rate_limit_per_day=0;" 2>/dev/null
        docker exec "$REDIS_C" redis-cli --scan --pattern "ratelimit:*" 2>/dev/null | while read -r key; do
            docker exec "$REDIS_C" redis-cli DEL "$key" >/dev/null 2>&1
        done
        info "API 限流已取消（-1 = 不限制）"
        _rl_show
    }

    _rl_reset() {
        docker exec "$REDIS_C" redis-cli HSET "system:rate_limits" \
            per_minute 10 per_hour 100 per_day 500 >/dev/null 2>&1
        docker exec "$PG_C" psql -U tsuser -d ts_platform -c \
            "UPDATE system_configs SET value='10' WHERE key='rate_limit_per_minute';
             UPDATE system_configs SET value='100' WHERE key='rate_limit_per_hour';
             UPDATE system_configs SET value='500' WHERE key='rate_limit_per_day';" 2>/dev/null
        docker exec "$PG_C" psql -U tsuser -d ts_platform -c \
            "UPDATE api_keys SET rate_limit_per_minute=0, rate_limit_per_hour=0, rate_limit_per_day=0;" 2>/dev/null
        info "API 限流已恢复默认值 (10/100/500)"
        _rl_show
    }

    if [ -n "$action" ]; then
        case "$action" in
            show)    _rl_show ;;
            disable) _rl_disable ;;
            reset)   _rl_reset ;;
            *)       echo "用法: $0 ratelimit {show|disable|reset}" ;;
        esac
        return
    fi

    # 交互式子菜单
    _rl_show
    echo -e "  ${CYAN}1)${NC} 查看当前限流"
    echo -e "  ${CYAN}2)${NC} 取消限流 (-1 不限制)"
    echo -e "  ${CYAN}3)${NC} 恢复默认 (10/100/500)"
    echo -e "  ${DIM}q) 返回${NC}"
    echo ""
    read -rp "  请选择: " rl_choice
    case "$rl_choice" in
        1) _rl_show ;;
        2) _rl_disable ;;
        3) _rl_reset ;;
        *) ;;
    esac
}

cmd_configcheck() {
    local action="${1:-}"
    local method="${2:-qwen}"

    local _BE_PORT=$(grep API_PORT .env 2>/dev/null | cut -d= -f2 || echo "8100")
    local _ADMIN_PASS=$(grep SEED_ADMIN_PASSWORD .env 2>/dev/null | cut -d= -f2 || echo "admin123")
    local _BACKEND=$(docker ps --format '{{.Names}}' | grep -i backend | grep -i ts-platform | head -1 || echo "")
    local _REDIS=$(docker ps --format '{{.Names}}' | grep -i redis | grep -i ts-platform | head -1 || echo "")

    _cc_token() {
        curl -s "http://localhost:$_BE_PORT/api/v1/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"username\":\"admin\",\"password\":\"$_ADMIN_PASS\"}" 2>/dev/null \
            | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo ""
    }

    # ── 1. 服务健康 ──
    _cc_health() {
        echo ""
        echo -e "${BOLD}  1. 服务健康${NC}"
        echo ""
        local code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$_BE_PORT/api/v1/auth/me" 2>/dev/null)
        if [ "$code" = "401" ]; then
            local ver=$(curl -s "http://localhost:$_BE_PORT/api/v1/health" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'v{d.get(\"version\",\"?\")} (build: {d.get(\"build_time\",\"?\")})' )" 2>/dev/null || echo "?")
            info "后端正常, 版本: $ver"
        else
            warn "后端不可用 (HTTP $code)"
        fi
        local fe_port=$(grep FRONTEND_PORT .env 2>/dev/null | cut -d= -f2 || echo "3000")
        local fe_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$fe_port" 2>/dev/null)
        [ "$fe_code" = "200" ] && info "前端正常 (端口 $fe_port)" || warn "前端不可用 (HTTP $fe_code)"
        local vllm_n=$(pgrep -f "vllm.entrypoints" 2>/dev/null | wc -l)
        [ "$vllm_n" -gt 0 ] && info "vLLM 运行中 ($vllm_n 个进程)" || warn "vLLM 未运行"
        echo ""
    }

    # ── 2. 配置方案（数据库原始值）──
    _cc_db_config() {
        echo ""
        echo -e "${BOLD}  2. 推理配置方案 — 数据库原始值${NC}"
        echo ""
        [ -z "$_BACKEND" ] && { warn "未找到 backend 容器"; return; }
        local m="${1:-$method}"
        docker exec "$_BACKEND" python3 -c "
import asyncio
from app.core.database import async_session
from app.models.config_template import InferenceConfigTemplate
from sqlalchemy import select
async def check():
    async with async_session() as db:
        result = await db.execute(select(InferenceConfigTemplate).where(InferenceConfigTemplate.algorithm_name=='$m'))
        configs = result.scalars().all()
        if not configs:
            print(f'  未找到 $m 的配置方案')
            return
        print(f'  $m 配置方案: {len(configs)} 条')
        print()
        for c in configs:
            dp = c.default_params or {}
            pre = dp.get('preprocess', {})
            post = dp.get('postprocess', {})
            mcfg = dp.get('method', {})
            tag = '启用' if c.enabled else '禁用'
            print(f'  [{tag}] id={c.id}  name=\"{c.name}\"  model_id={c.model_id}')
            if pre:
                print(f'    数据处理: skip_step={pre.get(\"skip_on_step\", pre.get(\"skipOnStep\",\"未设置\"))}, skip_noise={pre.get(\"skip_on_noise\", pre.get(\"skipOnNoise\",\"未设置\"))}, fill={pre.get(\"fill_missing\",\"未设置\")}, dedup={pre.get(\"dedup\",\"未设置\")}, n_ds={pre.get(\"n_downsample\", pre.get(\"nDownsample\",\"未设置\"))}, ds={pre.get(\"downsampler\",\"未设置\")}')
            else:
                print(f'    数据处理: (未配置)')
            if post:
                print(f'    后处理:   merge_gap={post.get(\"merge_gap\", post.get(\"mergeGap\",\"未设置\"))}, edge_align={post.get(\"edge_align\", post.get(\"edgeAlign\",\"未设置\"))}')
            if mcfg:
                print(f'    算法参数: temperature={mcfg.get(\"temperature\",\"未设置\")}, max_tokens={mcfg.get(\"max_tokens\", mcfg.get(\"maxTokens\",\"未设置\"))}')
            print()
asyncio.run(check())
" 2>/dev/null || warn "数据库查询失败"
    }

    # ── 3. 配置生效验证（API 实际值）──
    _cc_api_config() {
        echo ""
        echo -e "${BOLD}  3. 配置生效验证 — API 实际使用值${NC}"
        echo ""
        local token=$(_cc_token)
        [ -z "$token" ] && { warn "登录失败"; return; }
        local m="${1:-$method}"
        local result=$(curl -s "http://localhost:$_BE_PORT/api/v1/inference/config-check?method=$m" -H "Authorization: Bearer $token" 2>/dev/null)

        # 检测 API 返回是否有效（旧版镜像可能没有 config-check 端点）
        local api_status=$(echo "$result" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if 'detail' in d and 'method' not in d:
        print('not_found')
    elif d.get('method') is not None:
        print('ok')
    else:
        print('empty')
except:
    print('parse_error')
" 2>/dev/null)

        if [ "$api_status" = "not_found" ] || [ "$api_status" = "parse_error" ]; then
            warn "config-check API 端点不可用（旧版镜像不含此接口）"
            echo "  → 自动切换到容器内直接测试..."
            echo ""
            _cc_direct_test "$m"
            return
        fi

        echo "$result" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except:
    print('  接口不可用（可能是旧版本，需 hotpatch）')
    sys.exit(0)
pre = d.get('preprocess', {})
post = d.get('postprocess', {})
keys = d.get('loaded_config_keys', [])
print(f'  算法:       {d.get(\"method\")}')
print(f'  加载配置项: {keys or \"(无 — 使用默认值)\"}')
print()
print('  数据处理:')
for k in ('skip_on_step','skip_on_noise','fill_missing','dedup','n_downsample','downsampler'):
    v = pre.get(k)
    print(f'    {k:20s} {v}')
print()
print('  后处理:')
for k in ('merge_gap','edge_align','edge_align_window'):
    print(f'    {k:20s} {post.get(k)}')
print()
if keys:
    print('  ✓ 配置方案已加载')
else:
    print('  ✗ 配置方案未加载')
    print('  → 用选项 2 查看数据库中的配置方案是否存在且 enabled')
    print('  → 或选项 8 直接在容器内测试配置加载')
" 2>/dev/null || warn "查询失败"
        echo ""
    }

    # ── 4. 限流配置 ──
    _cc_ratelimit() {
        echo ""
        echo -e "${BOLD}  4. API 限流配置${NC}"
        echo ""
        if [ -n "$_REDIS" ]; then
            local minute=$(docker exec "$_REDIS" redis-cli HGET "system:rate_limits" per_minute 2>/dev/null | tr -d '\r')
            local hour=$(docker exec "$_REDIS" redis-cli HGET "system:rate_limits" per_hour 2>/dev/null | tr -d '\r')
            local day=$(docker exec "$_REDIS" redis-cli HGET "system:rate_limits" per_day 2>/dev/null | tr -d '\r')
            if [ -z "$minute" ]; then
                echo "  Redis: 未设置（使用代码默认值）"
            else
                echo "  Redis:  每分钟=$minute  每小时=$hour  每天=$day"
                [ "$minute" = "-1" ] && echo -e "  ${GREEN}(不限制)${NC}"
            fi
        else
            warn "未找到 Redis 容器"
        fi
        if [ -n "$_BACKEND" ]; then
            docker exec "$_BACKEND" python3 -c "
import asyncio
from app.core.database import async_session
from app.models.system_config import SystemConfig
from sqlalchemy import select
async def check():
    async with async_session() as db:
        result = await db.execute(select(SystemConfig).where(SystemConfig.key.like('rate_limit%')))
        configs = {r.key: r.value for r in result.scalars().all()}
        if configs:
            print(f'  DB:     每分钟={configs.get(\"rate_limit_per_minute\",\"?\")}'
                  f'  每小时={configs.get(\"rate_limit_per_hour\",\"?\")}'
                  f'  每天={configs.get(\"rate_limit_per_day\",\"?\")}')
        else:
            print('  DB:     未设置')
asyncio.run(check())
" 2>/dev/null || warn "数据库查询失败"
        fi
        echo ""
    }

    # ── 5. 并发配置 ──
    _cc_concurrency() {
        echo ""
        echo -e "${BOLD}  5. 并发配置${NC}"
        echo ""
        if [ -n "$_BACKEND" ]; then
            docker exec "$_BACKEND" python3 -c "
import asyncio
from app.core.database import async_session
from app.models.system_config import SystemConfig
from sqlalchemy import select
async def check():
    async with async_session() as db:
        result = await db.execute(select(SystemConfig).where(
            SystemConfig.key.in_(['max_gpu_concurrency','max_cpu_concurrency','gpu_sync_concurrency'])
        ))
        configs = {r.key: r.value for r in result.scalars().all()}
        gpu = configs.get('max_gpu_concurrency', '未设置(默认4)')
        cpu = configs.get('max_cpu_concurrency', '未设置(默认8)')
        sync = configs.get('gpu_sync_concurrency', '未设置(默认4)')
        print(f'  GPU 任务并发:             {gpu}  ← 控制 async 模式（编排层）')
        print(f'  CPU 任务并发:             {cpu}')
        print(f'  外部 API GPU 并发(同步):  {sync}  ← 仅控制 sync 模式')
asyncio.run(check())
" 2>/dev/null || warn "数据库查询失败"
        fi
        local token=$(_cc_token)
        if [ -n "$token" ]; then
            local eng=$(curl -s "http://localhost:$_BE_PORT/api/v1/inference/services" -H "Authorization: Bearer $token" 2>/dev/null \
                | python3 -c "import sys,json;print(len([s for s in json.load(sys.stdin).get('items',[]) if s.get('service_type')=='gpu']))" 2>/dev/null || echo "?")
            echo ""
            echo "  GPU 引擎数量: $eng"
            echo -e "  ${DIM}建议: GPU 任务并发 = 引擎数量${NC}"
        fi
        echo ""
    }

    # ── 6. GPU 引擎 ──
    _cc_engines() {
        echo ""
        echo -e "${BOLD}  6. GPU 引擎状态${NC}"
        echo ""
        local token=$(_cc_token)
        [ -z "$token" ] && { warn "登录失败"; return; }
        curl -s "http://localhost:$_BE_PORT/api/v1/inference/services" -H "Authorization: Bearer $token" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('items', [])
if not items:
    print('  未注册引擎')
else:
    for s in items:
        status = '在线' if s.get('status') == 'active' else s.get('status','?')
        algos = ', '.join(s.get('algorithms') or [])
        gpu = s.get('gpu_device', '?')
        print(f'  id={s[\"id\"]}  {s.get(\"display_name\",s.get(\"name\",\"?\")):<30s}  GPU={gpu}  状态={status}  算法={algos}')
        print(f'         endpoint={s.get(\"endpoint\",\"?\")}')
" 2>/dev/null || warn "查询失败"
        echo ""
    }

    # ── 7. Hotpatch 状态 ──
    _cc_hotpatch() {
        echo ""
        echo -e "${BOLD}  7. Hotpatch 状态${NC}"
        echo ""
        if grep -q "hotpatch" docker-compose.yml 2>/dev/null; then
            info "docker-compose.yml 中有 hotpatch 挂载:"
            grep "hotpatch" docker-compose.yml | sed 's/^/    /'
        else
            echo "  无 hotpatch volume 挂载"
        fi
        [ -d "data/hotpatch" ] && { echo "  data/hotpatch/ 文件:"; ls -la data/hotpatch/ 2>/dev/null | tail -n +2 | sed 's/^/    /'; }

        # 容器内代码版本检查
        if [ -n "$_BACKEND" ]; then
            echo ""
            echo -e "  ${BOLD}容器内代码版本检查:${NC}"
            # 检查 config-check 端点
            local has_cc=$(docker exec "$_BACKEND" grep -c "config-check" /app/app/api/inference_external.py 2>/dev/null || echo "0")
            if [ "$has_cc" -gt "0" ]; then
                echo -e "    ${GREEN}[OK]${NC} inference_external.py 包含 config-check 端点"
            else
                echo -e "    ${RED}[!]${NC}  inference_external.py 缺少 config-check 端点（需 hotpatch）"
            fi
            # 检查 _load_model_config 三层 fallback
            local has_fb=$(docker exec "$_BACKEND" grep -c "model_id.is_(None)" /app/app/api/inference_execution.py 2>/dev/null || echo "0")
            if [ "$has_fb" -gt "0" ]; then
                echo -e "    ${GREEN}[OK]${NC} inference_execution.py 包含 model_id=NULL fallback"
            else
                echo -e "    ${RED}[!]${NC}  inference_execution.py 缺少 model_id=NULL fallback（需 hotpatch）"
            fi
            # 检查 camelCase→snake_case 转换
            local has_snake=$(docker exec "$_BACKEND" grep -c "camel_to_snake" /app/app/api/inference_execution.py 2>/dev/null || echo "0")
            if [ "$has_snake" -gt "0" ]; then
                echo -e "    ${GREEN}[OK]${NC} inference_execution.py 包含 camelCase→snake_case 转换"
            else
                echo -e "    ${RED}[!]${NC}  inference_execution.py 缺少 camelCase 转换（旧版可能 key 不匹配）"
            fi
            # 检查 resolve_profile_config
            local has_rpc=$(docker exec "$_BACKEND" grep -c "preprocess_config" /app/app/algorithms/pipeline.py 2>/dev/null || echo "0")
            if [ "$has_rpc" -gt "0" ]; then
                echo -e "    ${GREEN}[OK]${NC} pipeline.py 包含 preprocess_config 解析"
            else
                echo -e "    ${RED}[!]${NC}  pipeline.py 缺少 preprocess_config 解析"
            fi
        fi
        echo ""
    }

    # ── 8. 容器内配置加载测试 ──
    _cc_direct_test() {
        echo ""
        echo -e "${BOLD}  8. 容器内配置加载测试 — 模拟 _load_model_config${NC}"
        echo ""
        [ -z "$_BACKEND" ] && { warn "未找到 backend 容器"; return; }
        local m="${1:-$method}"
        docker exec "$_BACKEND" python3 -c "
import asyncio, re
from app.core.database import async_session
from app.models.config_template import InferenceConfigTemplate
from sqlalchemy import select

def _camel_to_snake(name):
    return re.sub(r'([a-z])([A-Z])', r'\\1_\\2', name).lower()

async def test_load():
    method = '$m'
    async with async_session() as db:
        # Step 1: 查 model_id IS NULL + enabled
        result = await db.execute(
            select(InferenceConfigTemplate).where(
                InferenceConfigTemplate.algorithm_name == method,
                InferenceConfigTemplate.model_id.is_(None),
                InferenceConfigTemplate.enabled == True,
            ).limit(1)
        )
        config = result.scalars().first()
        step = 'model_id=NULL'

        # Step 2: fallback 任意 enabled
        if not config:
            result = await db.execute(
                select(InferenceConfigTemplate).where(
                    InferenceConfigTemplate.algorithm_name == method,
                    InferenceConfigTemplate.enabled == True,
                ).order_by(InferenceConfigTemplate.id.desc()).limit(1)
            )
            config = result.scalars().first()
            step = 'any enabled'

        if not config:
            print(f'  ✗ 未找到 {method} 的 enabled 配置方案')
            return

        print(f'  匹配方式:  {step}')
        print(f'  找到配置:  id={config.id}  name=\"{config.name}\"  enabled={config.enabled}')
        dp = config.default_params or {}
        if not dp:
            print(f'  ✗ default_params 为空，无配置内容')
            return

        print(f'  default_params sections: {list(dp.keys())}')
        print()

        # 模拟 _load_model_config 的逻辑
        full_config = {}
        for section in ('method', 'preprocess', 'postprocess'):
            section_data = dp.get(section, {})
            if isinstance(section_data, dict):
                if section == 'method':
                    full_config.update(section_data)
                else:
                    snake_data = {_camel_to_snake(k): v for k, v in section_data.items()}
                    full_config[f'{section}_config'] = snake_data

        print(f'  转换后 keys: {list(full_config.keys())}')
        print()

        pre = full_config.get('preprocess_config', {})
        post = full_config.get('postprocess_config', {})

        print('  数据处理 (preprocess_config):')
        for k in ('skip_on_step','skip_on_noise','fill_missing','dedup','n_downsample','downsampler'):
            v = pre.get(k, '(未设置)')
            print(f'    {k:20s} {v}')
        print()
        print('  后处理 (postprocess_config):')
        for k in ('merge_gap','edge_align','edge_align_window'):
            v = post.get(k, '(未设置)')
            print(f'    {k:20s} {v}')
        print()

        if full_config:
            print('  ✓ 配置加载模拟成功')
            if pre.get('skip_on_step') or pre.get('skip_on_noise') or post.get('edge_align'):
                print('  ✓ 预处理/后处理配置项已正确提取')
            else:
                print('  ⚠ 配置已加载但关键开关未启用，检查 default_params 结构')
        else:
            print('  ✗ 配置解析为空，推理时将使用默认值')

asyncio.run(test_load())
" 2>/dev/null || warn "容器内测试执行失败"
        echo ""
    }

    # ── 全部 ──
    _cc_all() {
        local m="${1:-$method}"
        _cc_health
        _cc_db_config "$m"
        _cc_api_config "$m"
        _cc_ratelimit
        _cc_concurrency
        _cc_engines
        _cc_hotpatch
        _cc_direct_test "$m"
    }

    # ── 命令行直接执行 ──
    if [ -n "$action" ]; then
        case "$action" in
            all)  _cc_all "$method" ;;
            *)    method="$action"; _cc_all "$method" ;;
        esac
        return
    fi

    # ── 交互式菜单 ──
    echo ""
    echo -e "${BOLD}  配置诊断${NC}"
    echo ""
    read -rp "  算法名称 [qwen]: " _m
    method=${_m:-qwen}
    echo ""
    echo -e "  ${CYAN}1)${NC} 服务健康"
    echo -e "  ${CYAN}2)${NC} 配置方案（数据库原始值）"
    echo -e "  ${CYAN}3)${NC} 配置生效验证（API 实际值）"
    echo -e "  ${CYAN}4)${NC} API 限流配置（Redis + DB）"
    echo -e "  ${CYAN}5)${NC} 并发配置 + 引擎数量"
    echo -e "  ${CYAN}6)${NC} GPU 引擎状态"
    echo -e "  ${CYAN}7)${NC} Hotpatch 状态 + 代码版本"
    echo -e "  ${CYAN}8)${NC} 容器内配置加载测试"
    echo -e "  ${CYAN}a)${NC} 全部检查"
    echo -e "  ${DIM}q) 返回${NC}"
    echo ""
    read -rp "  请选择: " _choice
    case "$_choice" in
        1) _cc_health ;;
        2) _cc_db_config ;;
        3) _cc_api_config ;;
        4) _cc_ratelimit ;;
        5) _cc_concurrency ;;
        6) _cc_engines ;;
        7) _cc_hotpatch ;;
        8) _cc_direct_test ;;
        a|A) _cc_all ;;
        *) ;;
    esac
}

cmd_update() {
    PARENT_DIR=$(dirname "$DEPLOY_DIR")
    NEW_PKG="$PARENT_DIR/ts-platform-offline.tar.gz"

    echo ""
    echo -e "${BOLD}  版本更新${NC}"
    echo ""

    if [ ! -f "$NEW_PKG" ]; then
        error "离线包不存在: $NEW_PKG\n请先将新版离线包传输到 $PARENT_DIR/"
    fi

    # 显示新旧版本信息
    NEW_SIZE=$(du -h "$NEW_PKG" | cut -f1)
    CUR_VER=""
    if [ -f "$DEPLOY_DIR/config/.env.template" ]; then
        CUR_VER="(当前部署中)"
    fi
    info "新离线包: $NEW_PKG ($NEW_SIZE)"
    info "当前部署: $DEPLOY_DIR $CUR_VER"

    echo ""
    warn "更新流程: 备份数据库 → 停止服务 → 停止 vLLM → 解压新版 → 部署 → 启动 vLLM"
    warn "数据库数据会保留（不删除数据卷）"
    echo ""
    read -rp "确认更新? 输入 yes 继续: " confirm
    if [ "$confirm" != "yes" ]; then
        info "已取消"
        return
    fi

    # Step 1: 备份数据库
    echo ""
    info "[1/6] 备份数据库..."
    cmd_backup 2>/dev/null || warn "备份失败（可能是首次部署无数据）"

    # Step 2: 停止服务
    info "[2/6] 停止服务..."
    docker compose stop 2>/dev/null || true

    # Step 3: 停止 vLLM 和 GPU Agent
    info "[3/6] 停止 vLLM 和 GPU Agent..."
    VLLM_PIDS=$(pgrep -f "vllm.entrypoints" 2>/dev/null || echo "")
    if [ -n "$VLLM_PIDS" ]; then
        echo "$VLLM_PIDS" | xargs kill 2>/dev/null || true
        sleep 3
        VLLM_PIDS=$(pgrep -f "vllm.entrypoints" 2>/dev/null || echo "")
        [ -n "$VLLM_PIDS" ] && echo "$VLLM_PIDS" | xargs kill -9 2>/dev/null || true
        info "vLLM 已停止"
    else
        info "vLLM 未在运行"
    fi
    AGENT_PIDS=$(pgrep -f "gpu_agent.py" 2>/dev/null || echo "")
    if [ -n "$AGENT_PIDS" ]; then
        echo "$AGENT_PIDS" | xargs kill 2>/dev/null || true
        info "GPU Agent 已停止"
    fi

    # Step 4: 保留数据卷，删除旧部署目录，解压新版
    info "[4/6] 解压新版..."
    # 保存 .env 和 backups
    SAVED_ENV=""
    if [ -f "$DEPLOY_DIR/.env" ]; then
        SAVED_ENV=$(cat "$DEPLOY_DIR/.env")
    fi
    SAVED_BACKUPS=""
    if [ -d "$DEPLOY_DIR/backups" ]; then
        SAVED_BACKUPS="$PARENT_DIR/_backups_tmp"
        mv "$DEPLOY_DIR/backups" "$SAVED_BACKUPS"
    fi
    # 保存 vLLM 启动配置（从当前运行的进程提取关键参数）
    SAVED_VLLM_MODEL=""
    SAVED_VLLM_PORT=""
    SAVED_VLLM_MAX_LEN=""
    SAVED_VLLM_DEVICE=""
    VLLM_PID=$(pgrep -f "vllm.entrypoints" 2>/dev/null | head -1 || echo "")
    if [ -n "$VLLM_PID" ]; then
        VLLM_ARGS=$(ps -p "$VLLM_PID" -o args= 2>/dev/null || echo "")
        SAVED_VLLM_MODEL=$(echo "$VLLM_ARGS" | grep -oE '\-\-model [^ ]+' | awk '{print $2}')
        SAVED_VLLM_PORT=$(echo "$VLLM_ARGS" | grep -oE '\-\-port [0-9]+' | awk '{print $2}')
        SAVED_VLLM_MAX_LEN=$(echo "$VLLM_ARGS" | grep -oE '\-\-max-model-len [0-9]+' | awk '{print $2}')
        SAVED_VLLM_DEVICE=$(echo "$VLLM_ARGS" | grep -oE 'CUDA_VISIBLE_DEVICES=[0-9,]+' | cut -d= -f2)
        info "保存 vLLM 配置: model=$SAVED_VLLM_MODEL port=$SAVED_VLLM_PORT max_len=$SAVED_VLLM_MAX_LEN"
    fi

    rm -rf "$DEPLOY_DIR"
    cd "$PARENT_DIR"
    tar xzf ts-platform-offline.tar.gz
    cd ts-platform-offline
    DEPLOY_DIR=$(pwd)

    # 恢复 .env 和 backups
    if [ -n "$SAVED_ENV" ]; then
        echo "$SAVED_ENV" > "$DEPLOY_DIR/.env"
        info "已恢复 .env 配置"

        # 检测新版模板是否有新增配置项
        if [ -f "$DEPLOY_DIR/config/.env.template" ]; then
            NEW_KEYS=""
            while IFS= read -r line; do
                # 跳过注释和空行
                [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
                key=$(echo "$line" | cut -d= -f1)
                if [ -n "$key" ] && ! grep -q "^${key}=" "$DEPLOY_DIR/.env" 2>/dev/null; then
                    NEW_KEYS="$NEW_KEYS\n    $line"
                fi
            done < "$DEPLOY_DIR/config/.env.template"

            if [ -n "$NEW_KEYS" ]; then
                warn "新版本新增了以下配置项（已用默认值添加到 .env）:"
                echo -e "$NEW_KEYS"
                # 自动追加新配置项到 .env
                echo "" >> "$DEPLOY_DIR/.env"
                echo "# --- 版本更新自动添加 ---" >> "$DEPLOY_DIR/.env"
                while IFS= read -r line; do
                    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
                    key=$(echo "$line" | cut -d= -f1)
                    if [ -n "$key" ] && ! grep -q "^${key}=" "$DEPLOY_DIR/.env" 2>/dev/null; then
                        echo "$line" >> "$DEPLOY_DIR/.env"
                    fi
                done < "$DEPLOY_DIR/config/.env.template"
                warn "请检查 .env 中的新配置项是否需要修改"
            fi
        fi
    fi
    if [ -n "$SAVED_BACKUPS" ] && [ -d "$SAVED_BACKUPS" ]; then
        mv "$SAVED_BACKUPS" "$DEPLOY_DIR/backups"
        info "已恢复备份文件"
    fi

    info "新版已解压"

    # Step 5: 重新部署（跳过配置，复用 .env）
    info "[5/6] 加载镜像并启动..."
    # 加载镜像
    for tarfile in images/*.tar.gz; do
        name=$(basename "$tarfile" .tar.gz)
        info "  加载 $name ..."
        docker load < "$tarfile"
    done

    # 复制 compose 文件
    cp config/docker-compose.yml .

    # 重新 source compose-compat（新脚本）
    source "$(dirname "$0")/compose-compat.sh" 2>/dev/null || true

    # 启动
    docker compose up -d
    info "等待服务就绪..."
    sleep 10

    # 数据库迁移
    docker compose exec -T backend bash -c "cd /app && PYTHONPATH=/app python -m scripts.seed" 2>/dev/null || warn "seed 跳过"
    docker compose exec -T backend bash -c "cd /app && PYTHONPATH=/app alembic stamp head" 2>/dev/null || warn "alembic stamp 跳过"

    # Step 6: 启动 vLLM
    info "[6/6] 启动 vLLM..."
    VLLM_ENV_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"
    if [ -n "$SAVED_VLLM_MODEL" ] && [ -f "$VLLM_ENV_DIR/bin/python3" ]; then
        # 用保存的参数自动启动（非交互）
        VLLM_PORT=${SAVED_VLLM_PORT:-8002}
        VLLM_MAX_LEN=${SAVED_VLLM_MAX_LEN:-8192}
        VLLM_DEVICE=${SAVED_VLLM_DEVICE:-0}
        info "使用上次配置自动启动: model=$SAVED_VLLM_MODEL port=$VLLM_PORT max_len=$VLLM_MAX_LEN"

        LOG_DIR="$DEPLOY_DIR/logs"
        mkdir -p "$LOG_DIR"
        LOG_FILE="$LOG_DIR/vllm_$(date +%Y%m%d_%H%M%S).log"
        env CUDA_VISIBLE_DEVICES="$VLLM_DEVICE" nohup "$VLLM_ENV_DIR/bin/python3" \
            -m vllm.entrypoints.openai.api_server \
            --model "$SAVED_VLLM_MODEL" --port "$VLLM_PORT" \
            --dtype auto --max-model-len "$VLLM_MAX_LEN" \
            --gpu-memory-utilization 0.9 \
            > "$LOG_FILE" 2>&1 &
        VLLM_PID=$!
        info "vLLM PID: $VLLM_PID, 日志: $LOG_FILE"

        info "等待端口 $VLLM_PORT 就绪..."
        for i in $(seq 1 60); do
            if curl -s "http://localhost:$VLLM_PORT/v1/models" >/dev/null 2>&1; then
                info "vLLM 启动成功"
                # 自动更新引擎配置
                _BE_PORT=$(grep API_PORT "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8100")
                _ADMIN_PASS=$(grep SEED_ADMIN_PASSWORD "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "admin123")
                _PY3="$VLLM_ENV_DIR/bin/python3"
                _TOKEN=$(curl -s "http://localhost:$_BE_PORT/api/v1/auth/login" \
                    -H "Content-Type: application/json" \
                    -d "{\"username\":\"admin\",\"password\":\"$_ADMIN_PASS\"}" 2>/dev/null \
                    | "$_PY3" -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")
                if [ -n "$_TOKEN" ]; then
                    _SVC_ID=$(curl -s "http://localhost:$_BE_PORT/api/v1/inference/services" \
                        -H "Authorization: Bearer $_TOKEN" 2>/dev/null \
                        | "$_PY3" -c "import sys,json;[print(s['id']) for s in json.load(sys.stdin).get('items',[]) if 'qwen' in (s.get('algorithms') or [])]" 2>/dev/null | head -1 || echo "")
                    if [ -n "$_SVC_ID" ]; then
                        curl -s -X PUT "http://localhost:$_BE_PORT/api/v1/inference/services/$_SVC_ID" \
                            -H "Authorization: Bearer $_TOKEN" -H "Content-Type: application/json" \
                            -d "{\"endpoint\":\"http://host.docker.internal:$VLLM_PORT/v1\",\"model_path\":\"$SAVED_VLLM_MODEL\"}" >/dev/null 2>&1
                        info "已更新引擎配置"
                    fi
                fi
                break
            fi
            if ! kill -0 "$VLLM_PID" 2>/dev/null; then
                warn "vLLM 启动失败，查看日志: tail -50 $LOG_FILE"
                warn "手动启动: sudo bash scripts/start-vllm.sh --start"
                break
            fi
            printf "."
            sleep 5
        done
    elif [ -f "$VLLM_ENV_DIR/bin/python3" ]; then
        # 没有保存的配置，交互式启动
        bash scripts/start-vllm.sh --start
    else
        warn "vLLM 环境未安装，跳过 GPU 推理启动"
    fi

    # 启动 GPU Agent
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
        if [ -f "$DEPLOY_DIR/scripts/gpu_agent.py" ] && [ -f "$VLLM_ENV_DIR/bin/python3" ]; then
            GPU_AGENT_PORT=$(grep GPU_AGENT_PORT "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "9100")
            mkdir -p "$DEPLOY_DIR/logs"
            nohup "$VLLM_ENV_DIR/bin/python3" "$DEPLOY_DIR/scripts/gpu_agent.py" --port "$GPU_AGENT_PORT" > "$DEPLOY_DIR/logs/gpu-agent.log" 2>&1 &
            info "GPU Agent 已启动 (PID=$!, 端口=$GPU_AGENT_PORT)"
        fi
    fi

    # 验证
    echo ""
    info "运行部署验证..."
    bash scripts/verify.sh || true

    # 显示版本信息
    BE_PORT=$(grep API_PORT "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8100")
    VLLM_ENV_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"
    PY3="${VLLM_ENV_DIR}/bin/python3"
    NEW_VER=$(curl -s "http://localhost:$BE_PORT/api/v1/health" 2>/dev/null \
        | "$PY3" -c "import sys,json;d=json.load(sys.stdin);print(f'v{d.get(\"version\",\"?\")} ({d.get(\"build_time\",\"?\")})')" 2>/dev/null || echo "?")

    echo ""
    echo "============================================================"
    info "更新完成! $NEW_VER"
    echo "============================================================"
    echo ""
    info "验收测试:"
    echo "  cd $PARENT_DIR"
    echo "  /opt/vllm-env/bin/python3 tests/run_acceptance.py --csv tests/tep_data_1year.csv --method qwen --url http://localhost:$BE_PORT"
    echo ""
}

show_menu() {
    echo ""
    echo -e "${BOLD}  TS-Platform 运维管理${NC}"
    echo ""
    cmd_status
    echo -e "  ${CYAN}1)${NC} 查看状态"
    echo -e "  ${CYAN}2)${NC} 查看日志"
    echo -e "  ${CYAN}3)${NC} 重启服务"
    echo -e "  ${CYAN}4)${NC} 停止服务"
    echo -e "  ${CYAN}5)${NC} 启动服务"
    echo -e "  ${CYAN}6)${NC} 备份数据库"
    echo -e "  ${CYAN}7)${NC} 部署验证"
    echo -e "  ${CYAN}8)${NC} 修改端口"
    echo -e "  ${CYAN}9)${NC} API 限流管理"
    echo -e "  ${CYAN}c)${NC} 推理配置诊断"
    echo -e "  ${CYAN}u)${NC} 版本更新 (从新离线包更新)"
    echo -e "  ${RED}r)${NC} 重置环境 (清除所有部署数据)"
    echo -e "  ${DIM}q) 退出${NC}"
    echo ""
}

# ─── Main ───

if [ $# -eq 0 ]; then
    # 交互式
    while true; do
        show_menu
        read -rp "  请选择: " choice
        echo ""
        case "$choice" in
            1) cmd_status ;;
            2) cmd_logs ;;
            3) cmd_restart ;;
            4) cmd_stop ;;
            5) cmd_start ;;
            6) cmd_backup ;;
            7) bash scripts/verify.sh ;;
            8) cmd_port ;;
            9) cmd_ratelimit ;;
            c|C) cmd_configcheck ;;
            u|U) cmd_update ;;
            r|R) cmd_reset ;;
            q|Q|"") echo -e "  ${DIM}再见${NC}"; exit 0 ;;
            *) warn "无效选项" ;;
        esac
        echo ""
        read -rp "  按回车继续..." _
    done
else
    case "$1" in
        status)  cmd_status ;;
        logs)    cmd_logs "${2:-}" ;;
        stop)    cmd_stop ;;
        start)   cmd_start ;;
        restart) cmd_restart ;;
        backup)  cmd_backup ;;
        restore) cmd_restore "${2:-}" ;;
        verify)  bash scripts/verify.sh ;;
        ratelimit) cmd_ratelimit "${2:-}" ;;
        configcheck) cmd_configcheck "${2:-qwen}" ;;
        port)    cmd_port ;;
        update)  cmd_update ;;
        reset)   cmd_reset ;;
        *)
            echo "用法: $0 {status|logs|stop|start|restart|backup|restore|verify|port|ratelimit|configcheck|update|reset}"
            echo "  ratelimit [show|disable|reset]  API 限流管理"
            echo "  configcheck [method]            推理配置诊断（默认 qwen）"
            echo "  不带参数启动交互式菜单"
            ;;
    esac
fi
