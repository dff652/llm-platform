# docker compose 兼容层
# 支持 plugin (docker compose) 和 standalone (docker-compose) 两种安装方式
# 用法: source "$(dirname "$0")/compose-compat.sh"
if ! docker compose version >/dev/null 2>&1; then
    if docker-compose version >/dev/null 2>&1; then
        docker() {
            if [ "$1" = "compose" ]; then
                shift
                command docker-compose "$@"
            else
                command docker "$@"
            fi
        }
    fi
fi
