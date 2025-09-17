#!/bin/bash

# Setup script for local Valkey cluster
# Based on https://github.com/avifenesh/glide-distributed-lock/blob/main/setup-cluster.sh

set -e

VALKEY_VERSION="8.0.1"
CLUSTER_FOLDER="valkey-cluster"
NODE_COUNT=6
BASE_PORT=7000
REPLICAS=1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Setting up Valkey cluster for testing...${NC}"

# Create cluster directory
mkdir -p $CLUSTER_FOLDER
cd $CLUSTER_FOLDER

# Download and build Valkey if not present
if [ ! -f "valkey-server" ]; then
    echo -e "${YELLOW}Downloading Valkey ${VALKEY_VERSION}...${NC}"
    wget -q https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VERSION}.tar.gz
    tar -xzf ${VALKEY_VERSION}.tar.gz
    cd valkey-${VALKEY_VERSION}
    echo -e "${YELLOW}Building Valkey...${NC}"
    make -j$(nproc) > /dev/null 2>&1
    cp src/valkey-server ../
    cp src/valkey-cli ../
    cd ..
    rm -rf valkey-${VALKEY_VERSION} ${VALKEY_VERSION}.tar.gz
    echo -e "${GREEN}Valkey built successfully${NC}"
fi

# Stop any existing cluster nodes
echo -e "${YELLOW}Stopping any existing cluster nodes...${NC}"
for port in $(seq $BASE_PORT $((BASE_PORT + NODE_COUNT - 1))); do
    if [ -f "${port}/valkey.pid" ]; then
        kill $(cat ${port}/valkey.pid) 2>/dev/null || true
        rm -f ${port}/valkey.pid
    fi
done

# Wait for ports to be released
sleep 2

# Create node directories and configs
echo -e "${YELLOW}Creating cluster nodes...${NC}"
for port in $(seq $BASE_PORT $((BASE_PORT + NODE_COUNT - 1))); do
    rm -rf ${port}
    mkdir -p ${port}

    cat > ${port}/valkey.conf <<EOF
port ${port}
cluster-enabled yes
cluster-config-file nodes-${port}.conf
cluster-node-timeout 5000
appendonly yes
appendfilename "appendonly-${port}.aof"
dbfilename dump-${port}.rdb
logfile valkey-${port}.log
daemonize yes
pidfile valkey.pid
dir ./
maxmemory 128mb
maxmemory-policy allkeys-lru
EOF

    # Start the node
    ./valkey-server ${port}/valkey.conf
    echo -e "${GREEN}Started node on port ${port}${NC}"
done

# Wait for nodes to start
echo -e "${YELLOW}Waiting for nodes to start...${NC}"
sleep 3

# Create the cluster
echo -e "${YELLOW}Creating cluster...${NC}"
CLUSTER_HOSTS=""
for port in $(seq $BASE_PORT $((BASE_PORT + NODE_COUNT - 1))); do
    CLUSTER_HOSTS="$CLUSTER_HOSTS 127.0.0.1:${port}"
done

./valkey-cli --cluster create $CLUSTER_HOSTS --cluster-replicas $REPLICAS --cluster-yes

# Verify cluster status
echo -e "${YELLOW}Verifying cluster...${NC}"
./valkey-cli -p $BASE_PORT cluster info

echo -e "${GREEN}Cluster setup complete!${NC}"
echo -e "${GREEN}Cluster is running on ports ${BASE_PORT}-$((BASE_PORT + NODE_COUNT - 1))${NC}"
echo ""
echo "To stop the cluster, run: npm run cluster:stop"
echo "To check cluster status: ./valkey-cluster/valkey-cli -p 7000 cluster info"