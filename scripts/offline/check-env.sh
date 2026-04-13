#!/usr/bin/env bash
#
# 环境检测脚本 — 部署前检查目标机器是否满足要求
#
set -euo pipefail

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}[PASS]${NC} $*"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $*"; ERRORS=$((ERRORS + 1)); }

ERRORS=0

echo ""
echo "============================================================"
echo "  TS-Platform 部署环境检测"
echo "============================================================"
echo ""

# ─── Docker ───
echo "Docker:"
if command -v docker >/dev/null 2>&1; then
    ver=$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
    pass "Docker 已安装 (v$ver)"
else
    fail "Docker 未安装"
fi

if docker compose version >/dev/null 2>&1; then
    ver=$(docker compose version --short 2>/dev/null)
    pass "docker compose v2 ($ver) [plugin]"
elif docker-compose version >/dev/null 2>&1; then
    ver=$(docker-compose version --short 2>/dev/null || docker-compose --version 2>/dev/null | grep -oE 'v[0-9.]+')
    pass "docker compose v2 ($ver) [standalone]"
else
    fail "docker compose v2 未安装"
fi

if docker info >/dev/null 2>&1; then
    pass "Docker 服务运行中"
else
    fail "Docker 服务未运行（sudo systemctl start docker）"
fi

# ─── 磁盘空间 ───
echo ""
echo "磁盘空间:"
FREE_GB=$(df -BG . | tail -1 | awk '{print $4}' | tr -d 'G')
if [ "$FREE_GB" -ge 50 ]; then
    pass "可用空间 ${FREE_GB}GB（需要 50GB+）"
elif [ "$FREE_GB" -ge 20 ]; then
    warn "可用空间 ${FREE_GB}GB（建议 50GB+，最低 20GB）"
else
    fail "可用空间 ${FREE_GB}GB（不足，需要至少 20GB）"
fi

# ─── 端口 ───
echo ""
echo "端口:"
for port in 3000 8100 5432 6380 8002; do
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then
        pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
        warn "端口 $port 已被占用（PID=$pid），部署时可更换端口"
    else
        pass "端口 $port 可用"
    fi
done

# ─── 内存 ───
echo ""
echo "内存:"
TOTAL_MB=$(free -m | awk '/Mem:/{print $2}')
if [ "$TOTAL_MB" -ge 8192 ]; then
    pass "总内存 $((TOTAL_MB / 1024))GB（需要 8GB+）"
elif [ "$TOTAL_MB" -ge 4096 ]; then
    warn "总内存 $((TOTAL_MB / 1024))GB（建议 8GB+）"
else
    fail "总内存 $((TOTAL_MB / 1024))GB（不足，需要至少 4GB）"
fi

# ─── CPU ───
echo ""
echo "CPU:"
CORES=$(nproc 2>/dev/null || echo 0)
if [ "$CORES" -ge 4 ]; then
    pass "CPU $CORES 核（需要 4+）"
else
    warn "CPU $CORES 核（建议 4+）"
fi

# ─── GPU（可选）───
echo ""
echo "GPU（可选）:"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    gpu_info=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
    pass "GPU: $gpu_info"

    # 驱动版本检测（vLLM 0.17 + CUDA 12.8 需要驱动 >= 535）
    driver_ver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || echo "")
    driver_major=$(echo "$driver_ver" | cut -d. -f1)
    if [ -n "$driver_major" ] && [ "$driver_major" -ge 535 ] 2>/dev/null; then
        pass "NVIDIA 驱动 $driver_ver（需要 >= 535）"
    elif [ -n "$driver_ver" ]; then
        warn "NVIDIA 驱动 $driver_ver（GPU 推理需要 >= 535）"
    fi
else
    warn "未检测到 GPU（CPU 算法仍可用，GPU 推理不可用）"
fi

# ─── glibc ───
echo ""
echo "系统库:"
GLIBC_VER=$(ldd --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo "")
if [ -n "$GLIBC_VER" ]; then
    # 用 awk 做版本比较，避免 shell 整数比较的各种兼容问题
    GLIBC_OK=$(echo "$GLIBC_VER" | awk -F. '{if ($1 > 2 || ($1 == 2 && $2 >= 17)) print "yes"; else print "no"}')
    if [ "$GLIBC_OK" = "yes" ]; then
        pass "glibc $GLIBC_VER（需要 >= 2.17）"
    else
        fail "glibc $GLIBC_VER（需要 >= 2.17，vLLM/PyTorch 依赖）"
    fi
else
    warn "无法检测 glibc 版本"
fi

# ─── SELinux / firewalld（CentOS）───
if command -v getenforce >/dev/null 2>&1; then
    echo ""
    echo "安全:"
    SELINUX_STATUS=$(getenforce 2>/dev/null || echo "unknown")
    if [ "$SELINUX_STATUS" = "Enforcing" ]; then
        warn "SELinux Enforcing，可能阻止 Docker 卷挂载（sudo setenforce 0）"
    else
        pass "SELinux: $SELINUX_STATUS"
    fi
fi

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then
    warn "firewalld 运行中，需开放端口: sudo firewall-cmd --permanent --add-port={3000,8100,8002}/tcp && sudo firewall-cmd --reload"
fi

# ─── Python3（验收测试需要）───
echo ""
echo "Python:"
if command -v python3 >/dev/null 2>&1; then
    py_ver=$(python3 --version 2>/dev/null)
    pass "$py_ver"
elif [ -f "${VLLM_ENV_DIR:-/opt/vllm-env}/bin/python3" ]; then
    pass "系统无 python3，但 vLLM 环境可用 (${VLLM_ENV_DIR:-/opt/vllm-env}/bin/python3)"
else
    warn "python3 未安装（验收测试需要: sudo apt install python3 python3-pip && pip3 install requests）"
fi

# ─── vLLM 环境（可选）───
echo ""
echo "vLLM 推理环境（可选）:"
VLLM_ENV_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"
if [ -d "$VLLM_ENV_DIR/bin" ]; then
    # 检查 Python 版本（必须 3.11）
    VLLM_PY_VER=$("$VLLM_ENV_DIR/bin/python3" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' || echo "unknown")
    if [ "$VLLM_PY_VER" = "3.11" ]; then
        pass "vLLM Python $VLLM_PY_VER（与 Docker 后端一致）"
    elif [ "$VLLM_PY_VER" != "unknown" ]; then
        fail "vLLM Python $VLLM_PY_VER（需要 3.11，版本不一致会导致渲染差异影响推理结果）"
    fi

    # 检查 vllm 包
    if "$VLLM_ENV_DIR/bin/python3" -c "import vllm; print(vllm.__version__)" 2>/dev/null | grep -q "0.17"; then
        vllm_ver=$("$VLLM_ENV_DIR/bin/python3" -c "import vllm; print(vllm.__version__)" 2>/dev/null)
        pass "vLLM $vllm_ver 已安装"
    else
        fail "vLLM 未安装或版本不对（需要 0.17.x）"
    fi
elif [ -f "vllm-env.tar.gz" ] || [ -f "../vllm-env.tar.gz" ]; then
    warn "vLLM 环境包存在但未解压，运行:"
    warn "  sudo bash scripts/start-vllm.sh --install"
    warn "  source $VLLM_ENV_DIR/bin/activate && conda-unpack"
else
    warn "vLLM 环境未安装（CPU 算法仍可用，GPU 推理不可用）"
fi

# ─── 镜像文件 ───
echo ""
echo "部署文件:"
for f in images/ts-platform-images.tar.gz images/postgres-16-alpine.tar.gz images/redis-7-alpine.tar.gz; do
    if [ -f "$f" ]; then
        size=$(du -h "$f" | cut -f1)
        pass "$f ($size)"
    else
        fail "$f 缺失"
    fi
done

if [ -f "config/docker-compose.yml" ]; then
    pass "config/docker-compose.yml"
else
    fail "config/docker-compose.yml 缺失"
fi

# ─── 结果 ───
echo ""
echo "============================================================"
if [ "$ERRORS" -eq 0 ]; then
    echo -e "  ${GREEN}环境检测通过，可以开始部署${NC}"
    echo "  运行: sudo bash scripts/deploy.sh"
else
    echo -e "  ${RED}发现 $ERRORS 个问题，请修复后重试${NC}"
fi
echo "============================================================"
echo ""

exit "$ERRORS"
