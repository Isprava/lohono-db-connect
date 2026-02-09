#!/bin/bash
# Import Redash queries and restart services
#
# Usage:
#   ./scripts/import-and-restart.sh <query_ids> [options]
#
# Examples:
#   ./scripts/import-and-restart.sh 42
#   ./scripts/import-and-restart.sh 42,99,103
#   ./scripts/import-and-restart.sh 42 --category revenue_analysis
#   ./scripts/import-and-restart.sh 42 --keywords "monthly revenue,sales"
#   ./scripts/import-and-restart.sh 42 --dry-run

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if running from project root
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: Must run from project root${NC}"
    exit 1
fi

# Check if query IDs provided
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: Query ID(s) required${NC}"
    echo ""
    echo "Usage: $0 <query_ids> [options]"
    echo ""
    echo "Examples:"
    echo "  $0 42"
    echo "  $0 42,99,103"
    echo "  $0 42 --category revenue_analysis"
    echo "  $0 42 --keywords \"monthly revenue,sales\""
    echo "  $0 42 --dry-run"
    exit 1
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Redash Query Import & Service Restart               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Run import
echo -e "${YELLOW}Step 1: Importing queries from Redash...${NC}"
npm run import-redash -- "$@"

# Check if dry-run was specified
if [[ "$*" == *"--dry-run"* ]]; then
    echo ""
    echo -e "${GREEN}✓ Dry run completed${NC}"
    exit 0
fi

# Check if --restart was specified
if [[ "$*" == *"--restart"* ]]; then
    echo ""
    echo -e "${GREEN}✓ Services will be restarted by the import tool${NC}"
    exit 0
fi

# Ask if user wants to restart
echo ""
read -p "Do you want to rebuild and restart services now? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}Step 2: Building TypeScript...${NC}"
    npm run build
    
    echo ""
    echo -e "${YELLOW}Step 3: Restarting Docker services...${NC}"
    docker compose up -d --build mcp-server mcp-client
    
    echo ""
    echo -e "${GREEN}✓ Services restarted successfully!${NC}"
    echo ""
    echo "Check status with: docker compose ps"
    echo "View logs with: docker compose logs -f mcp-server mcp-client"
else
    echo ""
    echo -e "${YELLOW}⚠ Services not restarted${NC}"
    echo ""
    echo "To apply changes later, run:"
    echo "  npm run build"
    echo "  docker compose up -d --build mcp-server mcp-client"
fi

echo ""
echo -e "${GREEN}✓ Import completed!${NC}"
