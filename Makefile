# ═══════════════════════════════════════════════════════════════════════════
# Lohono AI — Makefile
# ═══════════════════════════════════════════════════════════════════════════

COMPOSE     := docker compose
COMPOSE_OBS := docker compose -f docker-compose.observability.yml
SERVICES    := postgres mongo mcp-server mcp-client chat-client

# Default env file
ENV_FILE := .env

# DB backup settings
BACKUP_DIR  := db
DB_USER     ?= lohono_api
DB_NAME     ?= lohono_api_production
TIMESTAMP   := $(shell date +%Y%m%d_%H%M%S)

# ── Help ──────────────────────────────────────────────────────────────────

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Environment ───────────────────────────────────────────────────────────

.PHONY: env
env: ## Create .env from .env.example (will not overwrite existing)
	@if [ -f $(ENV_FILE) ]; then \
		echo "$(ENV_FILE) already exists — skipping"; \
	else \
		cp .env.example $(ENV_FILE); \
		echo "Created $(ENV_FILE) from .env.example — edit it with your secrets"; \
	fi

# ── All Services ──────────────────────────────────────────────────────────

.PHONY: up
up: env ## Start all services in foreground
	$(COMPOSE) up --build

.PHONY: up-d
up-d: env ## Start all services in background (detached)
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop and remove all containers
	$(COMPOSE) down

.PHONY: restart
restart: ## Restart all services
	$(COMPOSE) restart

.PHONY: build
build: ## Build all Docker images (no cache)
	$(COMPOSE) build --no-cache

.PHONY: ps
ps: ## Show running containers
	$(COMPOSE) ps

# ── Individual Services ───────────────────────────────────────────────────

.PHONY: postgres
postgres: env ## Start only PostgreSQL
	$(COMPOSE) up -d postgres

.PHONY: mongo
mongo: env ## Start only MongoDB
	$(COMPOSE) up -d mongo

.PHONY: mcp-server
mcp-server: env ## Start PostgreSQL + MCP server
	$(COMPOSE) up -d postgres mcp-server

.PHONY: mcp-client
mcp-client: env ## Start databases + MCP server + client
	$(COMPOSE) up -d postgres mongo mcp-server mcp-client

.PHONY: chat-client
chat-client: env ## Start everything including chat-client frontend
	$(COMPOSE) up -d postgres mongo mcp-server mcp-client chat-client

# ── Logs ──────────────────────────────────────────────────────────────────

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f

.PHONY: logs-postgres
logs-postgres: ## Tail PostgreSQL logs
	$(COMPOSE) logs -f postgres

.PHONY: logs-mongo
logs-mongo: ## Tail MongoDB logs
	$(COMPOSE) logs -f mongo

.PHONY: logs-mcp-server
logs-mcp-server: ## Tail MCP server logs
	$(COMPOSE) logs -f mcp-server

.PHONY: logs-mcp-client
logs-mcp-client: ## Tail MCP client logs
	$(COMPOSE) logs -f mcp-client

.PHONY: logs-chat-client
logs-chat-client: ## Tail chat-client frontend logs
	$(COMPOSE) logs -f chat-client

# ── Database: Backup & Restore ────────────────────────────────────────────
# Backups are stored in ./db/ and mounted at /backups in the postgres container.

.PHONY: db-backup
db-backup: ## Dump PostgreSQL to db/<timestamp>.sql.gz
	@mkdir -p $(BACKUP_DIR)
	@echo "Backing up $(DB_NAME) → $(BACKUP_DIR)/$(TIMESTAMP).sql.gz ..."
	$(COMPOSE) exec -T postgres pg_dump -U $(DB_USER) -d $(DB_NAME) \
		| gzip > $(BACKUP_DIR)/$(TIMESTAMP).sql.gz
	@echo "Done: $(BACKUP_DIR)/$(TIMESTAMP).sql.gz"

.PHONY: db-restore
db-restore: ## Restore PostgreSQL from DUMP=db/<file>.sql.gz
	@if [ -z "$(DUMP)" ]; then \
		echo "Usage: make db-restore DUMP=db/<file>.sql.gz"; \
		echo "Available dumps:"; ls -1 $(BACKUP_DIR)/*.sql.gz 2>/dev/null || echo "  (none)"; \
		exit 1; \
	fi
	@echo "Restoring $(DUMP) → $(DB_NAME) ..."
	gunzip -c $(DUMP) | $(COMPOSE) exec -T postgres psql -U $(DB_USER) -d $(DB_NAME)
	@echo "Restore complete."

.PHONY: db-list
db-list: ## List available database backups
	@echo "Backups in $(BACKUP_DIR)/:"
	@ls -lh $(BACKUP_DIR)/*.sql.gz 2>/dev/null || echo "  (none)"

.PHONY: db-shell
db-shell: ## Open a psql shell in the postgres container
	$(COMPOSE) exec postgres psql -U $(DB_USER) -d $(DB_NAME)

.PHONY: mongo-shell
mongo-shell: ## Open a mongosh shell in the mongo container
	$(COMPOSE) exec mongo mongosh

# ── Development (local, no Docker) ────────────────────────────────────────

.PHONY: dev-install
dev-install: ## Install all npm dependencies (root + chat-client)
	npm install
	npm --prefix chat-client install

.PHONY: dev-server
dev-server: ## Run MCP SSE server locally (requires PG)
	npx tsx src/index-sse.ts

.PHONY: dev-client
dev-client: ## Run MCP client API locally (requires PG + Mongo + MCP server)
	npx tsx src/client/index.ts

.PHONY: dev-chat-client
dev-chat-client: ## Run chat-client frontend dev server (Vite, port 8080)
	npm --prefix chat-client run dev

.PHONY: dev
dev: ## Print instructions for local dev (run each in a separate terminal)
	@echo "Start each in a separate terminal:"
	@echo "  1. make postgres mongo          # databases"
	@echo "  2. make dev-server              # MCP SSE server  (port 3000)"
	@echo "  3. make dev-client              # Client REST API (port 3001)"
	@echo "  4. make dev-chat-client                 # Web UI          (port 8080)"

# ── Deployment ────────────────────────────────────────────────────────────

.PHONY: deploy
deploy: env ## Build and start all services (production, detached)
	@echo "═══ Deploying Lohono AI ═══"
	$(COMPOSE) up -d --build --remove-orphans
	@echo ""
	@echo "═══ Deployment complete ═══"
	@echo "  Web UI:       http://localhost:$${WEB_PORT:-8080}"
	@echo "  Client API:   http://localhost:$${CLIENT_PORT:-3001}"
	@echo "  MCP Server:   http://localhost:$${MCP_PORT:-3000}"
	@echo ""
	$(COMPOSE) ps

# ── Observability (SigNoz + OpenTelemetry) ─────────────────────────────────

.PHONY: obs-network
obs-network: ## Create shared Docker network (run once)
	@docker network inspect lohono-network >/dev/null 2>&1 || \
		docker network create lohono-network
	@echo "Network lohono-network ready."

.PHONY: obs-up
obs-up: env obs-network ## Start observability stack (SigNoz + OTel Collector)
	$(COMPOSE_OBS) up -d --build
	@echo ""
	@echo "═══ Observability stack running ═══"
	@echo "  SigNoz UI:        http://localhost:$${SIGNOZ_PORT:-3301}"
	@echo "  OTel Collector:    localhost:$${OTEL_GRPC_PORT:-4317} (gRPC)"
	@echo ""

.PHONY: obs-down
obs-down: ## Stop observability stack
	$(COMPOSE_OBS) down

.PHONY: obs-logs
obs-logs: ## Tail observability stack logs
	$(COMPOSE_OBS) logs -f

.PHONY: obs-ps
obs-ps: ## Show observability stack status
	$(COMPOSE_OBS) ps

.PHONY: obs-clean
obs-clean: ## Stop observability stack and remove volumes
	$(COMPOSE_OBS) down --volumes --remove-orphans
	@echo "Observability stack cleaned up."

.PHONY: deploy-all
deploy-all: env obs-network ## Deploy app + observability (1-click production)
	@echo "═══ Deploying Lohono AI + Observability ═══"
	$(COMPOSE_OBS) up -d --build
	OTEL_SDK_DISABLED=false $(COMPOSE) up -d --build --remove-orphans
	@echo ""
	@echo "═══ Full deployment complete ═══"
	@echo "  Web UI:         http://localhost:$${WEB_PORT:-8080}"
	@echo "  Client API:     http://localhost:$${CLIENT_PORT:-3001}"
	@echo "  MCP Server:     http://localhost:$${MCP_PORT:-3000}"
	@echo "  SigNoz UI:      http://localhost:$${SIGNOZ_PORT:-3301}"
	@echo "  OTel Collector:  localhost:$${OTEL_GRPC_PORT:-4317}"
	@echo ""
	$(COMPOSE) ps
	$(COMPOSE_OBS) ps

# ── Cleanup ───────────────────────────────────────────────────────────────

.PHONY: clean
clean: ## Stop containers and remove images + volumes
	$(COMPOSE) down --rmi local --volumes --remove-orphans
	@echo "Cleaned up containers, images, and volumes."

.PHONY: clean-all
clean-all: clean obs-clean ## Stop everything and remove all volumes
	@echo "All stacks cleaned up."

.PHONY: prune
prune: ## Remove dangling Docker resources (system-wide)
	docker system prune -f
