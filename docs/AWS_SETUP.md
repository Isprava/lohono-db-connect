# AWS Setup Guide — AIDA (Lohono AI Database Context)

## Table of Contents

1. [Architecture](#architecture)
2. [Minimum Configuration](#minimum-configuration)
3. [AWS Resources Required](#aws-resources-required)
4. [Step-by-Step Setup](#step-by-step-setup)
5. [Environment Variables](#environment-variables)
6. [Database Restore](#database-restore)
7. [Deploy](#deploy)
8. [Nginx Reverse Proxy](#nginx-reverse-proxy)
9. [SSL and Domain](#ssl-and-domain)
10. [Google OAuth](#google-oauth)
11. [Observability (Optional)](#observability-optional)
12. [Backups](#backups)
13. [Maintenance](#maintenance)
14. [Security Hardening](#security-hardening)
15. [Cost Estimates](#cost-estimates)
16. [Troubleshooting](#troubleshooting)

---

## Architecture

```
Internet
    |
ALB (HTTPS:443, HTTP:80 -> redirect)
    |
EC2 Instance
    |
nginx (port 80) -- reverse proxy
    |
    +-- /          -> chat-client container (port 8080)  [React SPA via nginx]
    +-- /api/*     -> mcp-client container  (port 3001)  [Express + Claude]
    +-- /health    -> 200 OK (ALB health check)
    |
    (internal only, not exposed)
    +-- mcp-server (port 3000)  [MCP protocol, DB tools]
    +-- postgres   (port 5432)  [lohono_api_production]
    +-- mongo      (port 27017) [session/chat storage]
```

**Five Docker containers** run on a single EC2 instance:

| Container | Image | Port | Role |
|-----------|-------|------|------|
| `chat-client` | nginx:alpine (serves React build) | 8080 | Web UI |
| `mcp-client` | node:20-alpine | 3001 | Express API, Claude orchestration, Google OAuth |
| `mcp-server` | node:20-alpine | 3000 | MCP SSE server, DB tools, ACL enforcement |
| `postgres` | postgres:16-alpine | 5432 | Production database |
| `mongo` | mongo:7 | 27017 | Chat sessions, auth sessions |

Only `chat-client` (8080) and `mcp-client` (3001) are reachable via nginx. All other ports are internal to the Docker network.

---

## Minimum Configuration

### Compute — EC2

| Spec | Minimum | Recommended |
|------|---------|-------------|
| **Instance type** | `t3.medium` (2 vCPU, 4 GB) | `t3.large` (2 vCPU, 8 GB) |
| **AMI** | Ubuntu Server 22.04 LTS x86_64 | Same |
| **Root volume** | 30 GB gp3 | 30 GB gp3 |
| **Data volume** (optional) | — | 50 GB gp3 (for DB growth) |
| **Architecture** | x86_64 (amd64) | Same |

> `t3.medium` works for light usage (<5 concurrent users). If Claude tool-use loops
> run alongside DB queries, memory can spike to ~3.5 GB. Use `t3.large` (8 GB) for
> comfortable headroom, or `t3.xlarge` (16 GB) if running the observability stack too.

### Memory Breakdown (Approximate)

| Service | Idle | Under Load |
|---------|------|------------|
| PostgreSQL | 200 MB | 500 MB |
| MongoDB | 150 MB | 300 MB |
| MCP Server (Node.js) | 80 MB | 200 MB |
| MCP Client (Node.js) | 100 MB | 300 MB |
| Chat Client (nginx) | 10 MB | 20 MB |
| Host OS + nginx + Docker | 400 MB | 600 MB |
| **Total** | **~940 MB** | **~1.9 GB** |

With observability stack (ClickHouse + SigNoz + OTel Collector), add ~2-3 GB.

### Network / DNS

| Resource | Required |
|----------|----------|
| Elastic IP | 1 (attached to EC2) |
| ALB | 1 (Application Load Balancer) |
| Target Group | 1 (HTTP:80 -> EC2) |
| Route 53 hosted zone | For `lohono.com` (or your domain) |
| ACM certificate | 1 (for `ailabs.lohono.com`) |

### Security Groups

**ALB Security Group:**

| Direction | Port | Source | Purpose |
|-----------|------|--------|---------|
| Inbound | 80 | 0.0.0.0/0 | HTTP (redirects to HTTPS) |
| Inbound | 443 | 0.0.0.0/0 | HTTPS |

**EC2 Security Group:**

| Direction | Port | Source | Purpose |
|-----------|------|--------|---------|
| Inbound | 22 | Your IP/VPN CIDR | SSH |
| Inbound | 80 | ALB security group | Traffic from ALB |
| Outbound | 443 | 0.0.0.0/0 | HTTPS to Anthropic API, Google OAuth |

> Do NOT expose ports 3000, 3001, 5432, 27017 to the internet.

### Required Credentials

| Credential | Where to Get It |
|------------|-----------------|
| **Anthropic API key** | https://console.anthropic.com |
| **PostgreSQL dump** | Export from your production/staging DB |
| **Google OAuth Client ID + Secret** | Google Cloud Console -> APIs & Services -> Credentials |
| **SSH key pair** | AWS EC2 -> Key Pairs |

---

## AWS Resources Required

Summary of everything you need to create in AWS:

1. **EC2 instance** — `t3.medium` or larger, Ubuntu 22.04
2. **Elastic IP** — attach to the EC2 instance
3. **Security groups** — one for ALB, one for EC2 (see above)
4. **Application Load Balancer** — HTTPS:443 listener + HTTP:80 redirect
5. **Target Group** — HTTP:80, health check path `/health`
6. **ACM Certificate** — for `ailabs.lohono.com` (DNS-validated)
7. **Route 53 A record** — alias `ailabs.lohono.com` -> ALB
8. **(Optional) S3 bucket** — for database backup storage

---

## Step-by-Step Setup

### 1. Launch EC2

```bash
# AWS Console -> EC2 -> Launch Instance
# Name:           aida-production
# AMI:            Ubuntu Server 22.04 LTS (x86_64)
# Instance type:  t3.large (or t3.medium for minimum)
# Key pair:       Select or create one
# Security group: Create with SSH (22) from your IP
# Storage:        30 GB gp3 root volume
```

### 2. SSH into the instance

```bash
ssh -i ~/.ssh/your-key.pem ubuntu@<ELASTIC_IP>
```

### 3. Install Docker

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git unzip htop

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt-get install -y docker-compose-plugin

# Re-login for group changes
exit
```

Re-connect via SSH, then verify:

```bash
docker --version          # Docker 24+
docker compose version    # Docker Compose v2+
```

### 4. Configure Docker log rotation

```bash
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF

sudo systemctl restart docker
```

### 5. Clone the repository

```bash
cd ~
git clone git@github.com:Isprava/lohono-db-connect.git lohono-db-context
cd lohono-db-context
```

---

## Environment Variables

### Create `.env`

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

### Minimum Required `.env`

These are the only variables you **must** set. Everything else has sensible defaults.

```bash
# ── REQUIRED ─────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE
DB_PASSWORD=a_strong_random_password_here

# ── RECOMMENDED (production) ─────────────────────────────────
DEPLOYMENT_MODE=production
PUBLIC_DOMAIN=ailabs.lohono.com
NODE_ENV=production
```

### Full `.env` Reference

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ANTHROPIC_API_KEY` | **Yes** | — | Claude API key |
| `DB_PASSWORD` | **Yes** | `lohono_api_password` | **Change for production** |
| `DB_USER` | No | `lohono_api` | PostgreSQL user |
| `DB_NAME` | No | `lohono_api_production` | PostgreSQL database |
| `DB_EXTERNAL_PORT` | No | `5433` | Host port for direct PG access |
| `MONGO_PORT` | No | `27017` | Host port for MongoDB |
| `MONGODB_DB_NAME` | No | `mcp_client` | MongoDB database name |
| `MCP_PORT` | No | `3000` | MCP server port |
| `CLIENT_PORT` | No | `3001` | MCP client API port |
| `WEB_PORT` | No | `8080` | Chat client port |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-5-20250929` | Claude model ID |
| `DEPLOYMENT_MODE` | No | `local` | `local` or `production` |
| `PUBLIC_DOMAIN` | No | `ailabs.lohono.com` | Used when `DEPLOYMENT_MODE=production` |
| `REDASH_URL` | No | — | Redash instance URL |
| `REDASH_API_KEY` | No | — | Redash API key |
| `MCP_USER_EMAIL` | No | — | Fallback email for stdio mode |
| `OTEL_SDK_DISABLED` | No | `true` | Set `false` to enable tracing |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `SIGNOZ_PORT` | No | `3301` | SigNoz UI port |

---

## Database Restore

### Transfer the dump from your local machine

```bash
# From local machine
scp -i ~/.ssh/your-key.pem db/your_dump.sql.gz \
    ubuntu@<ELASTIC_IP>:~/lohono-db-context/db/
```

### Restore on the server

```bash
cd ~/lohono-db-context

# Start PostgreSQL only
make postgres

# Wait for healthy status (~30s)
docker compose ps postgres

# Restore
make db-restore DUMP=db/your_dump.sql.gz

# Verify
make db-shell
# => SELECT count(*) FROM staffs;
# => \q
```

---

## Deploy

### Start all services

```bash
make deploy
```

This builds all Docker images and starts 5 containers in detached mode. Wait ~2 minutes for everything to become healthy.

### Verify

```bash
# All containers should show "Up" and "healthy"
make ps

# Health checks
curl -s http://localhost:3000/health    # MCP Server
curl -s http://localhost:3001/api/health # MCP Client
curl -s http://localhost:8080/           # Chat Client (HTML)
```

### View logs

```bash
make logs                # All services
make logs-mcp-server     # MCP Server only
make logs-mcp-client     # MCP Client only
make logs-chat-client    # Chat Client only
```

---

## Nginx Reverse Proxy

Nginx runs on the host (not in Docker) and forwards ALB traffic to the Docker containers.

### Install nginx

```bash
sudo apt-get install -y nginx
sudo rm /etc/nginx/sites-enabled/default
```

### Create config

```bash
sudo tee /etc/nginx/sites-available/lohono-mcp > /dev/null <<'NGINX'
upstream mcp_web {
    server localhost:8080;
    keepalive 32;
}

upstream mcp_api {
    server localhost:3001;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ailabs.lohono.com;

    client_max_body_size 10M;

    access_log /var/log/nginx/ailabs-access.log;
    error_log  /var/log/nginx/ailabs-error.log warn;

    # ALB health check
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }

    # API -> MCP Client
    location /api/ {
        proxy_pass http://mcp_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

    # Web UI -> Chat Client
    location / {
        proxy_pass http://mcp_web;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ /\. {
        deny all;
    }
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }

    location / {
        return 444;
    }
}
NGINX
```

### Enable and start

```bash
sudo ln -sf /etc/nginx/sites-available/lohono-mcp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl start nginx
```

### Verify

```bash
curl http://localhost/health        # -> "healthy"
curl http://localhost/api/health    # -> JSON from MCP Client
curl -I http://localhost/           # -> 200 OK
```

---

## SSL and Domain

### 1. Request ACM Certificate

- AWS Console -> **Certificate Manager** (same region as ALB)
- Request a **public certificate** for `ailabs.lohono.com`
- Use **DNS validation**
- Add the CNAME record ACM provides to your Route 53 hosted zone
- Wait for status "Issued" (~5-30 min)

### 2. Create Route 53 A Record

- Route 53 -> Hosted zone `lohono.com`
- Create record:
  - **Name**: `ailabs`
  - **Type**: A (Alias)
  - **Route to**: Application Load Balancer -> your ALB

### 3. Configure ALB Listeners

**HTTPS:443 listener:**
- Default action: Forward to target group
- SSL certificate: Select ACM cert
- Security policy: `ELBSecurityPolicy-TLS13-1-2-2021-06`

**HTTP:80 listener:**
- Default action: Redirect to `HTTPS:443` (301)

### 4. Configure Target Group

- Protocol: HTTP, Port: 80
- Target: Your EC2 instance
- Health check path: `/health`
- Healthy threshold: 2
- Interval: 30s

### 5. Verify

```bash
curl https://ailabs.lohono.com/health       # -> "healthy"
curl https://ailabs.lohono.com/api/health   # -> JSON
```

---

## Google OAuth

Authentication requires a Google OAuth 2.0 Client configured for your domain. Only users whose email exists in the `staffs` table with `active = true` can log in.

### 1. Create OAuth Client

- Google Cloud Console -> APIs & Services -> Credentials
- Create **OAuth 2.0 Client ID** (Web application)
- **Authorized JavaScript origins**: `https://ailabs.lohono.com`
- **Authorized redirect URIs**: `https://ailabs.lohono.com/auth/callback`

### 2. Authorize Staff Users

```bash
make db-shell

-- Check existing staff
SELECT id, email, name, active FROM staffs WHERE active = true LIMIT 20;

-- Add a new user
INSERT INTO staffs (email, name, active)
VALUES ('user@lohono.com', 'User Name', true);

\q
```

> The `auth.lohono.com` OAuth provider already allows `localhost:8080`, `*.lohono.com`, and `*.isprava.com` redirect URIs.

---

## Observability (Optional)

The observability stack adds distributed tracing, structured logs, and metrics via SigNoz + OpenTelemetry. It requires **an additional ~2-3 GB RAM** — use `t3.xlarge` (16 GB) if enabling this.

### Enable

```bash
# Edit .env
OTEL_SDK_DISABLED=false

# Start the full stack
make deploy-all
```

### Access

- **SigNoz UI**: `http://<ELASTIC_IP>:3301`
- **OTel Collector health**: `http://localhost:13133`

### Services added

| Container | Image | Purpose |
|-----------|-------|---------|
| `clickhouse` | clickhouse/clickhouse-server:24.1-alpine | Trace/log storage |
| `signoz-otel-collector` | signoz/signoz-otel-collector:0.102.12 | SigNoz ingest |
| `signoz-query-service` | signoz/query-service:0.102.12 | Query API |
| `signoz-frontend` | signoz/frontend:0.102.12 | SigNoz UI (:3301) |
| `otel-collector` | otel/opentelemetry-collector-contrib:0.102.0 | App telemetry receiver |

### Skip observability

If you don't need it, keep `OTEL_SDK_DISABLED=true` (the default) and just run `make deploy`.

---

## Backups

### Manual

```bash
make db-backup                              # -> db/<timestamp>.sql.gz
make db-list                                # List backups
make db-restore DUMP=db/20260210.sql.gz     # Restore
```

### Automated daily backup (cron)

```bash
crontab -e
```

```cron
# Daily backup at 02:00 IST
0 2 * * * cd /home/ubuntu/lohono-db-context && docker compose exec -T postgres pg_dump -U lohono_api lohono_api_production | gzip > db/backup-$(date +\%Y\%m\%d-\%H\%M\%S).sql.gz

# Prune backups older than 7 days at 03:00
0 3 * * * find /home/ubuntu/lohono-db-context/db -name "backup-*.sql.gz" -mtime +7 -delete
```

### Sync to S3

```bash
sudo apt-get install -y awscli
aws configure    # Enter access key, secret, region

# Add to cron after the backup job
30 2 * * * aws s3 sync /home/ubuntu/lohono-db-context/db s3://your-bucket/lohono-backups/ --exclude "*" --include "backup-*.sql.gz"
```

---

## Maintenance

### Update application code

```bash
cd ~/lohono-db-context
git pull origin main
make deploy
```

### Update a single service (zero-downtime)

```bash
# Rebuild and restart just one service
make service-down SERVICE=mcp-client
make service-up SERVICE=mcp-client

# Or with docker compose directly
docker compose up -d --build --no-deps mcp-client
```

### Restart all services

```bash
make restart
```

### View running containers

```bash
make ps
```

### Database shell

```bash
make db-shell       # psql
make mongo-shell    # mongosh
```

### Regenerate database catalog

Run this after schema migrations:

```bash
npx tsx database/scripts/catalog-tables-direct.ts
```

---

## Security Hardening

### Firewall (UFW)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp       # SSH
sudo ufw allow 80/tcp       # ALB -> nginx
sudo ufw enable
```

> Don't open 8080, 3000, 3001, 5432, 27017 — they should only be reachable via Docker's internal network or nginx.

### Automatic security updates

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### File permissions

```bash
chmod 600 .env
```

### Docker best practices

- All containers use `restart: unless-stopped`
- All containers have health checks
- PostgreSQL credentials are passed via environment variables (not baked into images)
- Database ports are not exposed to the host in production (`DB_EXTERNAL_PORT` is only for direct debugging)

---

## Cost Estimates

All prices are approximate for `us-east-1` (monthly, on-demand).

### Option A: Single EC2 — All-in-one (Recommended to start)

| Resource | Spec | Cost/month |
|----------|------|------------|
| EC2 | t3.large (2 vCPU, 8 GB) | ~$60 |
| EBS | 30 GB gp3 root | ~$2.40 |
| EBS | 50 GB gp3 data (optional) | ~$4.00 |
| Elastic IP | 1 | ~$3.60 |
| ALB | 1 | ~$16 + LCU |
| Route 53 | Hosted zone | ~$0.50 |
| ACM | Certificate | Free |
| **Total** | | **~$87/month** |

### Option B: Minimum viable (Cost-sensitive)

| Resource | Spec | Cost/month |
|----------|------|------------|
| EC2 | t3.medium (2 vCPU, 4 GB) | ~$30 |
| EBS | 30 GB gp3 | ~$2.40 |
| Elastic IP | 1 | ~$3.60 |
| ALB | 1 | ~$16 + LCU |
| **Total** | | **~$52/month** |

### Option C: With observability stack

| Resource | Spec | Cost/month |
|----------|------|------------|
| EC2 | t3.xlarge (4 vCPU, 16 GB) | ~$120 |
| EBS | 80 GB gp3 | ~$6.40 |
| Elastic IP + ALB + Route 53 | — | ~$20 |
| **Total** | | **~$147/month** |

### Cost Optimization Tips

- **Savings Plans / Reserved Instances**: 30-40% savings for 1-year commitment
- **t3a instead of t3**: ~10% cheaper (AMD processors), same performance
- **Spot instances**: Not recommended — interruptions break long-running Claude conversations
- **Schedule stop/start**: If not used 24/7, stop the instance overnight

---

## Troubleshooting

### Containers won't start

```bash
make logs                           # Check all container logs
docker compose ps                   # See which containers are unhealthy
sudo systemctl status docker        # Check Docker daemon
```

### Out of memory

```bash
free -h                             # Check system memory
docker stats --no-stream            # Per-container memory usage
```

If memory is tight, consider upgrading the instance type or disabling observability.

### MCP Client can't connect to MCP Server

```bash
docker compose ps mcp-server        # Check health status
docker compose logs mcp-server --tail 50
curl http://localhost:3000/health    # Test from host
```

### Claude API errors

```bash
docker compose logs mcp-client --tail 50 | grep -i error
# Verify ANTHROPIC_API_KEY is set correctly
grep ANTHROPIC_API_KEY .env
```

### Authentication failures (403)

The user's Google email must exist in the `staffs` table:

```bash
make db-shell
SELECT email, active FROM staffs WHERE email = 'user@example.com';
```

### 502 Bad Gateway from nginx

```bash
# Check Docker containers are running
docker compose ps

# Check nginx can reach upstreams
curl http://localhost:8080
curl http://localhost:3001/api/health

# Check nginx error log
sudo tail -20 /var/log/nginx/ailabs-error.log
```

### Database connection errors

```bash
docker compose ps postgres
docker compose exec postgres pg_isready -U lohono_api
make logs-postgres
```

### Quick health check script

```bash
echo "--- Service Health ---"
curl -sf http://localhost:3000/health    > /dev/null && echo "MCP Server:  OK" || echo "MCP Server:  FAIL"
curl -sf http://localhost:3001/api/health > /dev/null && echo "MCP Client:  OK" || echo "MCP Client:  FAIL"
curl -sf http://localhost:8080/          > /dev/null && echo "Chat Client: OK" || echo "Chat Client: FAIL"
curl -sf http://localhost/health         > /dev/null && echo "Nginx:       OK" || echo "Nginx:       FAIL"
```
