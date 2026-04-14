#!/usr/bin/env bash
#
# LLM-Platform 容器部署管理工具
#
# 交互式:  ./scripts/deploy-test.sh
# 命令式:  ./scripts/deploy-test.sh <command>
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
ENV_FILE=".env.test"
COMPOSE_PROJECT="ts-test"
EXPORT_DIR="$PROJECT_DIR/dist"
EXPORT_FILE="$EXPORT_DIR/llm-platform-images.tar.gz"
PACK_FILE="$EXPORT_DIR/llm-platform-deploy.tar.gz"

IMG_FRONTEND="llm-platform/frontend:latest"
IMG_BACKEND="llm-platform/backend:latest"
IMG_POSTGRES="postgres:16-alpine"
IMG_REDIS="redis:7-alpine"

# ---- 颜色 & 样式 ----

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "${CYAN}[STEP]${NC} $*"; }

# ---- docker compose wrapper ----

dc() {
    docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" "$@"
}

# ---- 状态检测 ----

has_source() { [ -f "docker/Dockerfile.backend" ]; }
has_images() { docker image inspect "$IMG_BACKEND" >/dev/null 2>&1; }
has_tar()    { [ -f "llm-platform-images.tar.gz" ] || [ -f "$EXPORT_FILE" ]; }
has_env()    { [ -f "$ENV_FILE" ]; }

containers_running() {
    local count
    count=$(dc ps -q 2>/dev/null | wc -l)
    [ "$count" -gt 0 ]
}

get_container_status() {
    if containers_running; then
        local total running
        total=$(dc ps -q 2>/dev/null | wc -l)
        running=$(dc ps --filter "status=running" -q 2>/dev/null | wc -l)
        echo -e "${GREEN}运行中${NC} ($running/$total)"
    else
        echo -e "${DIM}未启动${NC}"
    fi
}

get_image_status() {
    if has_images; then
        local size
        size=$(docker images --format '{{.Size}}' "$IMG_BACKEND" 2>/dev/null | head -1)
        echo -e "${GREEN}已构建${NC} ($size)"
    else
        echo -e "${DIM}未构建${NC}"
    fi
}

# ---- 交互式菜单 ----

show_banner() {
    echo ""
    echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${BLUE}║     LLM-Platform 容器部署管理工具         ║${NC}"
    echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # 环境状态
    echo -e "${BOLD}  当前状态:${NC}"
    echo -e "    容器:  $(get_container_status)"
    echo -e "    镜像:  $(get_image_status)"

    local env_label
    if has_env; then
        local fp bp
        bp=$(grep API_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
        fp=$(grep FRONTEND_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
        env_label="${GREEN}已配置${NC} (前端:${fp:-3100} 后端:${bp:-8200})"
    else
        env_label="${YELLOW}未配置${NC}"
    fi
    echo -e "    配置:  $env_label"

    if has_source; then
        echo -e "    源码:  ${GREEN}可用${NC} (可构建镜像)"
    else
        echo -e "    源码:  ${DIM}不可用${NC} (仅镜像启动)"
    fi
    echo ""
}

show_menu() {
    local has_src=false
    has_source && has_src=true

    echo -e "${BOLD}  请选择操作:${NC}"
    echo ""

    if $has_src; then
        echo -e "  ${BOLD}构建 & 打包${NC}"
        echo -e "    ${CYAN}1)${NC} 一键部署        构建镜像 + 启动 + 初始化数据库"
        echo -e "    ${CYAN}2)${NC} 只构建镜像      构建 frontend + backend 镜像"
        echo -e "    ${CYAN}3)${NC} 导出镜像        构建 + 导出为 tar.gz"
        echo -e "    ${CYAN}4)${NC} 打包部署包      构建 + 打包(镜像+配置+脚本)"
        echo ""
    fi

    echo -e "  ${BOLD}部署 & 运行${NC}"
    echo -e "    ${CYAN}5)${NC} 启动服务        从已有镜像启动 (不构建)"
    echo -e "    ${CYAN}6)${NC} 加载镜像        从 tar.gz 加载镜像"
    echo -e "    ${CYAN}c)${NC} 环境预检        检查 Docker/端口/磁盘/GPU"
    echo ""

    if containers_running; then
        echo -e "  ${BOLD}运维管理${NC}"
        echo -e "    ${CYAN}7)${NC} 查看状态        容器状态 + 端口映射"
        echo -e "    ${CYAN}8)${NC} 查看日志        实时日志 (Ctrl+C 退出)"
        echo -e "    ${CYAN}9)${NC} 重启服务        停止 + 重新启动"
        echo -e "    ${CYAN}s)${NC} 停止服务        停止所有容器"
        echo -e "    ${RED}d)${NC} 销毁环境        停止 + 删除容器和数据卷"
        echo ""
    fi

    echo -e "    ${DIM}q) 退出${NC}"
    echo ""
}

interactive_menu() {
    while true; do
        show_banner
        show_menu

        local choice
        read -rp "  请输入选项: " choice
        echo ""

        case "$choice" in
            1)
                has_source || { warn "无源码，请用选项 5 从镜像启动"; sleep 1; continue; }
                has_env || { warn "请先创建 $ENV_FILE"; sleep 1; continue; }
                cmd_preflight; cmd_build; cmd_up; cmd_init_db; echo ""; cmd_status
                echo ""; read -rp "  按回车继续..." _
                ;;
            2)
                has_source || { warn "无源码，无法构建"; sleep 1; continue; }
                has_env || { warn "请先创建 $ENV_FILE"; sleep 1; continue; }
                cmd_build
                echo ""; read -rp "  按回车继续..." _
                ;;
            3)
                has_source || { warn "无源码，无法构建"; sleep 1; continue; }
                has_env || { warn "请先创建 $ENV_FILE"; sleep 1; continue; }
                cmd_export
                echo ""; read -rp "  按回车继续..." _
                ;;
            4)
                has_source || { warn "无源码，无法构建"; sleep 1; continue; }
                has_env || { warn "请先创建 $ENV_FILE"; sleep 1; continue; }
                cmd_pack
                echo ""; read -rp "  按回车继续..." _
                ;;
            5)
                has_env || { warn "请先创建 $ENV_FILE (cp .env.test .env.test)"; sleep 1; continue; }
                cmd_start
                echo ""; read -rp "  按回车继续..." _
                ;;
            6)
                local tar_path
                read -rp "  镜像文件路径 (留空自动查找): " tar_path
                cmd_import "" "${tar_path:-}"
                echo ""; read -rp "  按回车继续..." _
                ;;
            7)
                cmd_status
                echo ""; read -rp "  按回车继续..." _
                ;;
            8)
                info "查看日志 (Ctrl+C 退出)..."
                dc logs -f --tail=50 || true
                ;;
            9)
                cmd_stop; cmd_up
                echo ""; read -rp "  按回车继续..." _
                ;;
            s|S)
                cmd_stop
                echo ""; read -rp "  按回车继续..." _
                ;;
            d|D)
                cmd_down
                echo ""; read -rp "  按回车继续..." _
                ;;
            c|C)
                cmd_preflight
                echo ""; read -rp "  按回车继续..." _
                ;;
            q|Q|"")
                echo -e "  ${DIM}再见${NC}"
                exit 0
                ;;
            *)
                warn "无效选项: $choice"
                sleep 1
                ;;
        esac
    done
}

# ---- 环境预检 ----

cmd_preflight() {
    step "环境预检..."
    local ok=true

    # Docker
    if ! command -v docker &>/dev/null; then
        error "未安装 Docker"
    fi
    local dv
    dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0")
    info "Docker: $dv"

    # docker compose
    if ! docker compose version &>/dev/null; then
        error "未安装 docker compose v2 (需要 'docker compose', 不是 'docker-compose')"
    fi
    info "Docker Compose: $(docker compose version --short 2>/dev/null)"

    # 磁盘空间 (至少 10GB)
    local avail
    avail=$(df -BG . 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')
    if [ -n "$avail" ] && [ "$avail" -lt 10 ]; then
        warn "磁盘空间不足: ${avail}GB (建议 ≥ 20GB)"
        ok=false
    else
        info "磁盘空间: ${avail:-?}GB"
    fi

    # 端口检查
    local fp bp pp rp
    fp=$(grep FRONTEND_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    bp=$(grep API_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    pp=$(grep PG_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    rp=$(grep REDIS_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    fp=${fp:-3100}; bp=${bp:-8200}; pp=${pp:-5433}; rp=${rp:-6381}

    for port_info in "前端:$fp" "后端:$bp" "PostgreSQL:$pp" "Redis:$rp"; do
        local name=${port_info%%:*}
        local p=${port_info##*:}
        if ss -tlnp 2>/dev/null | grep -q ":${p} " || lsof -i:"$p" &>/dev/null; then
            warn "端口 $p ($name) 已被占用"
            ok=false
        else
            info "端口 $p ($name) 可用"
        fi
    done

    # GPU 检查 (可选)
    if command -v nvidia-smi &>/dev/null; then
        local gpu_count
        gpu_count=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l)
        info "GPU: ${gpu_count} 张"
        nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | while read -r line; do
            info "  $line"
        done
        # nvidia-container-toolkit
        if docker info 2>/dev/null | grep -qi nvidia; then
            info "nvidia-container-toolkit: 已安装"
        else
            warn "nvidia-container-toolkit 未检测到 (GPU 容器化推理需要)"
        fi
    else
        info "GPU: 未检测到 (平台可正常运行，GPU 推理需单独部署)"
    fi

    echo ""
    if $ok; then
        info "环境预检通过"
    else
        warn "存在问题，建议修复后再继续"
        read -rp "  是否继续？[y/N] " confirm
        [[ "$confirm" =~ ^[yY]$ ]] || exit 1
    fi
}

# ---- 功能函数 ----

cmd_check_wheel() {
    # 如果有 ts_quality 源码，始终重新构建以确保最新
    if [ -d "/home/douff/ts_quality" ]; then
        info "重新构建 ts_quality wheel..."
        rm -f docker/ts_quality-*.whl
        (cd /home/douff/ts_quality && ./build.sh source)
        cp /home/douff/ts_quality/dist/ts_quality-*.whl docker/
        info "ts_quality wheel 已更新"
    elif ! ls docker/ts_quality-*.whl >/dev/null 2>&1; then
        error "找不到 ts_quality 项目，也没有预构建的 wheel，请手动将 wheel 放到 docker/ 目录"
    else
        info "使用已有 ts_quality wheel: $(ls docker/ts_quality-*.whl)"
    fi
}

cmd_build() {
    step "1/2 检查依赖..."
    cmd_check_wheel

    step "2/2 构建镜像..."
    dc build

    echo ""
    info "镜像构建完成:"
    docker images --format "  {{.Repository}}:{{.Tag}}\t{{.Size}}" | grep "llm-platform/"
}

cmd_export() {
    cmd_build

    step "拉取基础镜像..."
    docker pull "$IMG_POSTGRES" 2>/dev/null || true
    docker pull "$IMG_REDIS" 2>/dev/null || true

    step "导出镜像为 tar.gz (含基础镜像)..."
    mkdir -p "$EXPORT_DIR"

    docker save "$IMG_FRONTEND" "$IMG_BACKEND" "$IMG_POSTGRES" "$IMG_REDIS" | gzip > "$EXPORT_FILE"

    local size
    size=$(du -h "$EXPORT_FILE" | cut -f1)
    echo ""
    info "镜像已导出: $EXPORT_FILE ($size)"
    info "包含: frontend, backend, postgres:16-alpine, redis:7-alpine"
}

cmd_pack() {
    cmd_export

    step "打包完整部署包..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    local pack_dir="$tmp_dir/llm-platform"
    mkdir -p "$pack_dir/scripts"

    cp "$EXPORT_FILE"              "$pack_dir/llm-platform-images.tar.gz"
    cp "$PROJECT_DIR/docker-compose.yml" "$pack_dir/"
    cp "$PROJECT_DIR/.env.test"          "$pack_dir/"
    cp "$PROJECT_DIR/.env.production"    "$pack_dir/" 2>/dev/null || true
    cp "$PROJECT_DIR/scripts/deploy-test.sh" "$pack_dir/scripts/"
    cp "$PROJECT_DIR/scripts/healthcheck.sh" "$pack_dir/scripts/" 2>/dev/null || true
    chmod +x "$pack_dir/scripts/"*.sh
    cp "$PROJECT_DIR/docs/offline-deploy.md" "$pack_dir/" 2>/dev/null || true

    cat > "$pack_dir/README.txt" << 'HEREDOC'
LLM-Platform 离线部署包
======================

快速启动（3 步）:

  1. 解压:  tar xzf llm-platform-deploy.tar.gz && cd llm-platform
  2. 配置:  cp .env.test .env.test && vim .env.test  (修改密码和端口)
  3. 启动:  ./scripts/deploy-test.sh

部署后验证:
  ./scripts/healthcheck.sh

目标机器要求: Docker 20+ / docker compose v2
不需要安装: Node.js, Python, Redis, PostgreSQL（全在容器内）

GPU 推理引擎需单独部署，详见 offline-deploy.md
HEREDOC

    mkdir -p "$EXPORT_DIR"
    tar czf "$PACK_FILE" -C "$tmp_dir" llm-platform
    rm -rf "$tmp_dir"

    local size
    size=$(du -h "$PACK_FILE" | cut -f1)
    echo ""
    info "部署包已生成: $PACK_FILE ($size)"
    echo ""
    info "目标机器使用方法:"
    echo "  scp $PACK_FILE user@target:/opt/"
    echo "  ssh user@target"
    echo "  cd /opt && tar xzf llm-platform-deploy.tar.gz && cd llm-platform"
    echo "  sudo ./scripts/deploy-test.sh"
}

cmd_import() {
    local tar_file="${2:-}"

    if [ -z "$tar_file" ]; then
        if [ -f "$EXPORT_FILE" ]; then
            tar_file="$EXPORT_FILE"
        elif [ -f "llm-platform-images.tar.gz" ]; then
            tar_file="llm-platform-images.tar.gz"
        else
            error "找不到镜像文件，请指定路径: $0 import <path/to/images.tar.gz>"
        fi
    fi

    step "加载镜像: $tar_file"
    docker load < "$tar_file"

    info "镜像已加载:"
    docker images --format "  {{.Repository}}:{{.Tag}}\t{{.Size}}" | grep "llm-platform/" || true
}

cmd_start() {
    # 环境预检
    cmd_preflight

    # 从已有镜像启动（不构建）
    if ! has_images; then
        if [ -f "llm-platform-images.tar.gz" ]; then
            cmd_import "" "llm-platform-images.tar.gz"
        elif [ -f "$EXPORT_FILE" ]; then
            cmd_import "" "$EXPORT_FILE"
        else
            error "镜像 $IMG_BACKEND 不存在，请先加载: $0 import <images.tar.gz>"
        fi
    fi

    cmd_up
    cmd_init_db
    echo ""
    cmd_status
}

cmd_up() {
    info "启动容器..."
    dc up -d
    echo ""
    info "等待服务就绪..."
    sleep 3

    local port
    port=$(grep API_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    port=${port:-8200}

    for i in $(seq 1 30); do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/api/v1/auth/me" 2>/dev/null || echo "000")
        if [ "$code" != "000" ]; then
            info "Backend 已就绪 (:${port})"
            break
        fi
        if [ "$i" -eq 30 ]; then
            warn "Backend 启动超时，请查看日志: dc logs backend"
        fi
        sleep 1
    done
}

cmd_init_db() {
    info "初始化数据库 (alembic upgrade head)..."
    dc exec backend alembic upgrade head

    info "创建初始管理员用户..."
    dc exec backend python -m scripts.seed || warn "seed 可能已执行过"
}

cmd_status() {
    echo ""
    dc ps
    echo ""
    info "端口映射:"
    local fp bp pp rp
    fp=$(grep FRONTEND_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    bp=$(grep API_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    pp=$(grep PG_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    rp=$(grep REDIS_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    echo "  Frontend:   http://localhost:${fp:-3100}"
    echo "  Backend:    http://localhost:${bp:-8200}"
    echo "  PostgreSQL: localhost:${pp:-5433}"
    echo "  Redis:      localhost:${rp:-6381}"
    echo ""
    info "默认账号: admin / admin123"
}

cmd_logs() {
    dc logs -f --tail=50
}

cmd_stop() {
    info "停止容器..."
    dc stop
}

cmd_down() {
    warn "将停止并删除所有测试容器和数据卷!"
    read -rp "确认? [y/N] " confirm
    if [[ "$confirm" =~ ^[yY]$ ]]; then
        dc down -v
        info "已清理"
    else
        info "已取消"
    fi
}

# ---- Main ----

# 无参数 → 交互式菜单
if [ $# -eq 0 ]; then
    interactive_menu
    exit 0
fi

# 有参数 → 命令式（兼容旧用法）
case "$1" in
    deploy|up)
        [ -f "$ENV_FILE" ] || error "找不到 $ENV_FILE"
        cmd_build; cmd_up; cmd_init_db; echo ""; cmd_status
        ;;
    start)
        [ -f "$ENV_FILE" ] || error "找不到 $ENV_FILE"
        cmd_start
        ;;
    build)
        [ -f "$ENV_FILE" ] || error "找不到 $ENV_FILE"
        cmd_build
        ;;
    export)
        [ -f "$ENV_FILE" ] || error "找不到 $ENV_FILE"
        cmd_export
        ;;
    pack)
        [ -f "$ENV_FILE" ] || error "找不到 $ENV_FILE"
        cmd_pack
        ;;
    import)
        cmd_import "$@"
        ;;
    stop)
        cmd_stop
        ;;
    down)
        cmd_down
        ;;
    logs)
        cmd_logs
        ;;
    status)
        cmd_status
        ;;
    restart)
        cmd_stop; cmd_up
        ;;
    *)
        echo "用法: $0 [command]"
        echo ""
        echo "  不带参数启动交互式菜单"
        echo ""
        echo "  deploy   构建 + 启动 + 初始化"
        echo "  start    从已有镜像启动（不构建）"
        echo "  build    只构建镜像"
        echo "  export   构建 + 导出镜像 tar.gz"
        echo "  pack     构建 + 打包完整部署包"
        echo "  import   加载镜像 tar.gz"
        echo "  stop     停止容器"
        echo "  down     停止 + 删除容器和数据卷"
        echo "  logs     查看实时日志"
        echo "  status   查看状态和端口"
        echo "  restart  重启容器"
        exit 1
        ;;
esac
