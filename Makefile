# ═══════════════════════════════════════════════════════════════════════════
# Lohono AI — Makefile
# ═══════════════════════════════════════════════════════════════════════════

COMPOSE       := docker compose
COMPOSE_LOCAL := docker compose -f docker-compose.yml -f docker-compose.local.yml
SERVICES      := mongo mcp-server helpdesk-server mcp-client chat-client

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
up: env ## Start all services in foreground (local — with SSH tunnel)
	$(COMPOSE_LOCAL) up --build

.PHONY: up-d
up-d: env ## Start all services in background (local — with SSH tunnel)
	$(COMPOSE_LOCAL) up -d --build

.PHONY: down
down: ## Stop and remove all containers
	$(COMPOSE_LOCAL) down

.PHONY: restart
restart: ## Restart all services
	$(COMPOSE_LOCAL) restart

.PHONY: service-down
service-down: ## Stop and remove a single service (usage: make service-down SERVICE=mcp-server)
	@if [ -z "$(SERVICE)" ]; then \
		echo "Usage: make service-down SERVICE=<service-name>"; \
		echo "Available services: $(SERVICES)"; \
		exit 1; \
	fi
	$(COMPOSE_LOCAL) stop $(SERVICE)
	$(COMPOSE_LOCAL) rm -f $(SERVICE)

.PHONY: service-up
service-up: env ## Build and start a single service (usage: make service-up SERVICE=mcp-server)
	@if [ -z "$(SERVICE)" ]; then \
		echo "Usage: make service-up SERVICE=<service-name>"; \
		echo "Available services: $(SERVICES)"; \
		exit 1; \
	fi
	$(COMPOSE_LOCAL) up -d --build $(SERVICE)

.PHONY: build
build: ## Build all Docker images (no cache)
	$(COMPOSE) build --no-cache

.PHONY: ps
ps: ## Show running containers
	$(COMPOSE) ps

# ── Individual Services ───────────────────────────────────────────────────

.PHONY: mongo
mongo: env ## Start only MongoDB
	$(COMPOSE) up -d mongo

.PHONY: mcp-server
mcp-server: env ## Start MCP server (requires external DB via .env)
	$(COMPOSE_LOCAL) up -d mcp-server

.PHONY: helpdesk-server
helpdesk-server: env ## Start helpdesk MCP server (requires AWS credentials)
	$(COMPOSE) up -d helpdesk-server

.PHONY: mcp-client
mcp-client: env ## Start MongoDB + MCP servers + client
	$(COMPOSE_LOCAL) up -d mongo mcp-server helpdesk-server mcp-client

.PHONY: chat-client
chat-client: env ## Start everything including chat-client frontend
	$(COMPOSE_LOCAL) up -d mongo mcp-server helpdesk-server mcp-client chat-client

# ── Logs ──────────────────────────────────────────────────────────────────

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f

.PHONY: logs-mongo
logs-mongo: ## Tail MongoDB logs
	$(COMPOSE) logs -f mongo

.PHONY: logs-mcp-server
logs-mcp-server: ## Tail MCP server logs
	$(COMPOSE) logs -f mcp-server

.PHONY: logs-helpdesk-server
logs-helpdesk-server: ## Tail helpdesk server logs
	$(COMPOSE) logs -f helpdesk-server

.PHONY: logs-mcp-client
logs-mcp-client: ## Tail MCP client logs
	$(COMPOSE) logs -f mcp-client

.PHONY: logs-chat-client
logs-chat-client: ## Tail chat-client frontend logs
	$(COMPOSE) logs -f chat-client

.PHONY: logs-tunnel
logs-tunnel: ## Tail SSH tunnel logs
	$(COMPOSE_LOCAL) logs -f ssh-tunnel

# ── Database: Backup & Restore ────────────────────────────────────────────
# Uses external PostgreSQL defined by DB_* vars in .env.
# Requires pg_dump / psql on the host (install: apt install postgresql-client).

.PHONY: db-backup
db-backup: ## Dump external PostgreSQL to db/<timestamp>.sql.gz
	@mkdir -p $(BACKUP_DIR)
	@echo "Backing up $(DB_NAME) @ $${DB_HOST}:$${DB_PORT} → $(BACKUP_DIR)/$(TIMESTAMP).sql.gz ..."
	PGPASSWORD=$(DB_PASSWORD) pg_dump -h $${DB_HOST} -p $${DB_PORT} -U $(DB_USER) -d $(DB_NAME) \
		| gzip > $(BACKUP_DIR)/$(TIMESTAMP).sql.gz
	@echo "Done: $(BACKUP_DIR)/$(TIMESTAMP).sql.gz"

.PHONY: db-restore
db-restore: ## Restore external PostgreSQL from DUMP=db/<file>.sql.gz
	@if [ -z "$(DUMP)" ]; then \
		echo "Usage: make db-restore DUMP=db/<file>.sql.gz"; \
		echo "Available dumps:"; ls -1 $(BACKUP_DIR)/*.sql.gz 2>/dev/null || echo "  (none)"; \
		exit 1; \
	fi
	@echo "Restoring $(DUMP) → $(DB_NAME) @ $${DB_HOST}:$${DB_PORT} ..."
	gunzip -c $(DUMP) | PGPASSWORD=$(DB_PASSWORD) psql -h $${DB_HOST} -p $${DB_PORT} -U $(DB_USER) -d $(DB_NAME)
	@echo "Restore complete."

.PHONY: db-list
db-list: ## List available database backups
	@echo "Backups in $(BACKUP_DIR)/:"
	@ls -lh $(BACKUP_DIR)/*.sql.gz 2>/dev/null || echo "  (none)"

.PHONY: db-shell
db-shell: ## Open a psql shell to external PostgreSQL
	PGPASSWORD=$(DB_PASSWORD) psql -h $${DB_HOST} -p $${DB_PORT} -U $(DB_USER) -d $(DB_NAME)

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
	@echo "Ensure DB_* vars in .env point to your external PostgreSQL."
	@echo ""
	@echo "Start each in a separate terminal:"
	@echo "  1. make mongo                   # MongoDB (conversations)"
	@echo "  2. make dev-server              # MCP SSE server  (port 3000)"
	@echo "  3. make dev-client              # Client REST API (port 3001)"
	@echo "  4. make dev-chat-client         # Web UI          (port 8080)"

# ── Deployment ────────────────────────────────────────────────────────────

.PHONY: deploy
deploy: env ## Build and start all services (production)
	@echo "═══ Deploying Lohono AI (production) ═══"
	@echo "Using external DB at $${DB_HOST}:$${DB_PORT}"
	$(COMPOSE) up -d --build --remove-orphans
	@echo ""
	@echo "═══ Deployment complete ═══"
	@echo "  Web UI:           http://localhost:$${WEB_PORT:-8080}"
	@echo "  Client API:       http://localhost:$${CLIENT_PORT:-3001}"
	@echo "  MCP Server:       http://localhost:$${MCP_PORT:-3000}"
	@echo "  Helpdesk Server:  http://localhost:$${HELPDESK_PORT:-3002}"
	@echo "  SigNoz UI:        http://localhost:$${SIGNOZ_PORT:-3301}"
	@echo "  OTel Collector:   localhost:$${OTEL_GRPC_PORT:-4317}"
	@echo ""
	$(COMPOSE) ps

# ── Observability (SigNoz + OpenTelemetry) ─────────────────────────────────
# Observability services (ClickHouse, SigNoz, OTel Collector) are now part of
# docker-compose.yml and start automatically with `make up-d`.

.PHONY: obs-logs
obs-logs: ## Tail observability logs (ClickHouse, SigNoz, OTel)
	$(COMPOSE) logs -f clickhouse schema-migrator signoz otel-collector

.PHONY: obs-ps
obs-ps: ## Show observability stack status
	$(COMPOSE) ps clickhouse schema-migrator signoz otel-collector

.PHONY: obs-clean
obs-clean: ## Remove observability volumes (ClickHouse + SigNoz data)
	$(COMPOSE) stop clickhouse signoz otel-collector
	$(COMPOSE) rm -f clickhouse schema-migrator signoz otel-collector
	docker volume rm -f lohono-db-context_signoz-clickhouse-data lohono-db-context_signoz-data 2>/dev/null || true
	@echo "Observability data cleaned up. Run 'make up-d' to recreate."

.PHONY: deploy-all
deploy-all: deploy ## Deploy app + observability (production, same as deploy)

# ── Redis ─────────────────────────────────────────────────────────────

.PHONY: redis-flush
redis-flush: ## Flush Redis cache and restart all services
	$(COMPOSE) exec redis redis-cli FLUSHALL
	$(COMPOSE) restart
	@echo "Redis cache flushed and all services restarted."

# ── Cleanup ───────────────────────────────────────────────────────────────

.PHONY: clean
clean: ## Stop containers and remove images + volumes
	$(COMPOSE) down --rmi local --volumes --remove-orphans
	@echo "Cleaned up containers, images, and volumes."

.PHONY: clean-all
clean-all: clean ## Stop everything and remove all volumes (including observability)
	@echo "All stacks cleaned up."

.PHONY: prune
prune: ## Remove dangling Docker resources (system-wide)
	docker system prune -f
