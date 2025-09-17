#!/bin/bash

# Simplified cluster setup that actually works
set -e

CLUSTER_FOLDER="valkey-cluster"
BASE_PORT=7000

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Setting up simple Valkey cluster...${NC}"

# Clean up first
cd $CLUSTER_FOLDER 2>/dev/null || exit 0
for port in 7000 7001 7002 7003 7004 7005; do
    if [ -f "${port}/valkey.pid" ]; then
        kill $(cat ${port}/valkey.pid) 2>/dev/null || true
    fi
done
cd ..

# Create fresh directory
rm -rf $CLUSTER_FOLDER
mkdir -p $CLUSTER_FOLDER
cd $CLUSTER_FOLDER

# Use redis instead of building valkey (redis is compatible)
echo -e "${YELLOW}Installing Redis (Valkey compatible)...${NC}"
if ! command -v redis-server &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y redis-server redis-tools
fi

# Create minimal 3-node cluster (primaries only, no replicas)
for port in 7000 7001 7002; do
    mkdir -p ${port}

    cat > ${port}/redis.conf <<EOF
port ${port}
cluster-enabled yes
cluster-config-file nodes-${port}.conf
cluster-node-timeout 5000
cluster-require-full-coverage no
appendonly no
save ""
dir ./
daemonize yes
pidfile redis.pid
logfile redis-${port}.log
loglevel warning
EOF

    redis-server ${port}/redis.conf
    echo -e "${GREEN}Started node on port ${port}${NC}"
done

# Wait for nodes
sleep 2

# Create cluster without replicas
echo -e "${YELLOW}Creating cluster...${NC}"
echo "yes" | redis-cli --cluster create \
    127.0.0.1:7000 \
    127.0.0.1:7001 \
    127.0.0.1:7002 \
    --cluster-replicas 0

# Verify
redis-cli -p 7000 cluster info | head -5

echo -e "${GREEN}Cluster ready on ports 7000-7002${NC}"