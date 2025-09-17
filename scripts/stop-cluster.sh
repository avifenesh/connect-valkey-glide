#!/bin/bash

# Stop script for local Valkey cluster

CLUSTER_FOLDER="valkey-cluster"
NODE_COUNT=6
BASE_PORT=7000

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Stopping Valkey cluster...${NC}"

cd $CLUSTER_FOLDER 2>/dev/null || {
    echo -e "${RED}Cluster directory not found${NC}"
    exit 1
}

# Stop all cluster nodes
for port in $(seq $BASE_PORT $((BASE_PORT + NODE_COUNT - 1))); do
    if [ -f "${port}/valkey.pid" ]; then
        PID=$(cat ${port}/valkey.pid)
        if kill $PID 2>/dev/null; then
            echo -e "${GREEN}Stopped node on port ${port}${NC}"
        fi
        rm -f ${port}/valkey.pid
    fi
done

echo -e "${GREEN}Cluster stopped${NC}"