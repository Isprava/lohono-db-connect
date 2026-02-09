# AWS Deployment Guide

Complete step-by-step guide to deploy Lohono Database Context MCP Platform on AWS EC2.

## Architecture Overview

**Domain**: `ailabs.lohono.com`

**Infrastructure:**
```
Internet
    ↓
ALB (Application Load Balancer)
    ├─ Listener: HTTPS:443 (with SSL certificate)
    └─ Listener: HTTP:80 (redirect to HTTPS)
        ↓
Target Group → EC2 Instance (t3.xlarge)
    ↓
nginx (Port 80) - Reverse Proxy
    ├─ https://ailabs.lohono.com/       → Docker: Web UI (Port 8080)
    ├─ https://ailabs.lohono.com/api/*  → Docker: MCP Client (Port 3001)
    └─ /health                           → Health check endpoint
        ↓
Docker Containers:
    ├─ Web UI (port 8080)          - React frontend
    ├─ MCP Client (port 3001)      - Express API + Claude integration
    ├─ MCP Server (port 3000)      - INTERNAL ONLY (not exposed)
    ├─ PostgreSQL (port 5432)      - Database
    └─ MongoDB (port 27017)        - Session storage
```

**Exposed Endpoints:**
- `https://ailabs.lohono.com` → Web UI (React SPA)
- `https://ailabs.lohono.com/api/*` → MCP Client API

**Internal Services** (not publicly accessible):
- MCP Server (port 3000) - Only accessed by MCP Client
- PostgreSQL (port 5432) - Only accessed by MCP Server and Client
- MongoDB (port 27017) - Only accessed by MCP Client

## Prerequisites

- AWS account with appropriate permissions
- SSH key pair for EC2 access
- Domain name (optional, for HTTPS setup)
- Anthropic API key for Claude

## Part 1: Launch EC2 Instance

### Step 1: Create EC2 Instance

1. **Log into AWS Console** → Navigate to EC2
2. **Click "Launch Instance"**
3. **Configure instance:**
   - **Name**: `lohono-mcp-production`
   - **AMI**: Ubuntu Server 22.04 LTS (64-bit x86)
   - **Instance type**: `t3.xlarge` (4 vCPU, 16 GB RAM)
   - **Key pair**: Select existing or create new SSH key pair
   - **Network settings**:
     - Create security group or select existing
     - Allow SSH (port 22) from your IP
     - Allow HTTP (port 80) - if using domain
     - Allow HTTPS (port 443) - if using domain
     - Allow Custom TCP (port 8080) - for web UI access
   - **Storage**: 
     - Root volume: 30 GB gp3
     - Add volume: 50 GB gp3 for databases (optional but recommended)
4. **Launch instance**

### Step 2: Configure Security Group

**Note**: Since you're using an Application Load Balancer (ALB) with Target Groups, configure security groups as follows:

**Security Group for ALB:**
| Type | Protocol | Port Range | Source | Description |
|------|----------|------------|--------|-------------|
| HTTP | TCP | 80 | 0.0.0.0/0 | Public HTTP traffic |
| HTTPS | TCP | 443 | 0.0.0.0/0 | Public HTTPS traffic |

**Security Group for EC2 Instance:**
| Type | Protocol | Port Range | Source | Description |
|------|----------|------------|--------|-------------|
| SSH | TCP | 22 | Your IP/CIDR | SSH access for management |
| HTTP | TCP | 80 | ALB Security Group | Traffic from ALB |
| Custom TCP | TCP | 8080 | ALB Security Group | Docker web UI (via nginx) |

**Security best practice**: EC2 instance should ONLY accept traffic from the ALB, not directly from the internet.

### Step 3: Configure Target Group

Your ALB should have a target group configured:

1. **Target Group Settings:**
   - **Protocol**: HTTP
   - **Port**: 80 (nginx will listen on this)
   - **Health check path**: `/` or `/health`
   - **Health check interval**: 30 seconds
   - **Healthy threshold**: 2
   - **Unhealthy threshold**: 3

2. **Register EC2 Instance:**
   - Add your EC2 instance to the target group
   - Ensure instance is marked as "healthy" after deployment

## Part 2: Server Setup

### Step 4: Connect to Instance

```bash
# Replace with your key file and Elastic IP
ssh -i ~/.ssh/your-key.pem ubuntu@YOUR_ELASTIC_IP
```

### Step 5: Update System

```bash
# Update package lists
sudo apt-get update

# Upgrade packages
sudo apt-get upgrade -y

# Install basic utilities
sudo apt-get install -y curl wget git unzip htop
```

### Step 6: Install Docker

```bash
# Install Docker using official script
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add current user to docker group (avoid sudo for docker commands)
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt-get install -y docker-compose-plugin

# Log out and back in for group changes to take effect
exit
```

Re-connect to the instance:
```bash
ssh -i ~/.ssh/your-key.pem ubuntu@YOUR_ELASTIC_IP
```

Verify Docker installation:
```bash
docker --version
docker compose version
```

### Step 7: Configure Additional Storage (Optional)

If you added a separate volume for databases:

```bash
# List block devices
lsblk

# Identify the new volume (usually /dev/xvdb or /dev/nvme1n1)
# Format the volume (only once!)
sudo mkfs.ext4 /dev/xvdb

# Create mount point
sudo mkdir -p /mnt/data

# Mount the volume
sudo mount /dev/xvdb /mnt/data

# Make it persistent across reboots
echo '/dev/xvdb /mnt/data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab

# Set permissions
sudo chown -R $USER:$USER /mnt/data
```

## Part 3: Deploy Application

### Step 8: Clone Repository

```bash
# Navigate to home directory
cd ~

# Clone the repository (replace with your repo URL)
git clone https://github.com/your-org/lohono-db-context.git

# Or if using SSH
# git clone git@github.com:your-org/lohono-db-context.git

cd lohono-db-context
```

### Step 9: Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

**Required environment variables to set:**

```bash
# Database credentials (CHANGE PASSWORD!)
DB_USER=lohono_api
DB_PASSWORD=CHANGE_THIS_SECURE_PASSWORD_123
DB_NAME=lohono_api_production
DB_EXTERNAL_PORT=5433

# MongoDB
MONGO_PORT=27017
MONGODB_DB_NAME=mcp_client

# Claude API
ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE
CLAUDE_MODEL=claude-sonnet-4-5-20250929

# Application ports
MCP_PORT=3000
CLIENT_PORT=3001
WEB_PORT=8080

# Observability (optional, enable if needed)
OTEL_SDK_DISABLED=true
LOG_LEVEL=info
NODE_ENV=production

# Redash integration (optional)
REDASH_URL=
REDASH_API_KEY=
```

Save and exit (`Ctrl+X`, then `Y`, then `Enter` in nano).

**Security best practices:**
- Use a strong, unique password for `DB_PASSWORD`
- Never commit `.env` to version control
- Restrict file permissions: `chmod 600 .env`

### Step 10: Restore Database (If You Have a Backup)

If you have a database dump from your local environment:

**Transfer dump to server:**
```bash
# From your local machine
scp -i ~/.ssh/your-key.pem db/your_dump.sql.gz ubuntu@YOUR_ELASTIC_IP:~/lohono-db-context/db/
```

**On the server:**
```bash
# Start PostgreSQL
make postgres

# Wait for it to be healthy (about 30 seconds)
docker compose ps postgres

# Restore database
make db-restore DUMP=db/your_dump.sql.gz
```

### Step 11: Deploy All Services

```bash
# Build and start all services
make deploy

# Or if you want observability stack too
make deploy-all
```

This will:
- Build all Docker images
- Start PostgreSQL, MongoDB, MCP Server, MCP Client, and Web UI
- Run in detached mode (background)

**Wait 2-3 minutes** for all services to start and become healthy.

### Step 12: Verify Deployment

```bash
# Check all containers are running
make ps

# Should show all services as "Up" and "healthy"
```

Check individual service health:
```bash
# MCP Server health
curl http://localhost:3000/health

# MCP Client health
curl http://localhost:3001/api/health

# Web UI (should return HTML)
curl http://localhost:8080
```

View logs if there are issues:
```bash
# All services
make logs

# Individual services
make logs-mcp-server
make logs-mcp-client
make logs-web
```

## Part 4: Configure Nginx Reverse Proxy

### Step 13: Install and Configure Nginx

Since you're using an ALB, nginx will act as a reverse proxy on the EC2 instance, forwarding traffic from port 80 (ALB → nginx) to the Docker containers.

**Your domain setup:**
- **Main application**: `ailabs.lohono.com` → Web UI
- **API endpoint**: `ailabs.lohono.com/api/*` → MCP Client API

**Note**: The MCP Server (port 3000) is NOT exposed externally - it's only accessed internally by the MCP Client.

**Install nginx:**

```bash
# Install nginx
sudo apt-get install -y nginx

# Remove default site
sudo rm /etc/nginx/sites-enabled/default
```

**Generate nginx configuration from your .env:**

```bash
# Ensure your .env has production settings
cat >> .env << EOF
DEPLOYMENT_MODE=production
PUBLIC_DOMAIN=ailabs.lohono.com
EOF

# Generate nginx config
./scripts/generate-nginx-config.sh /tmp/nginx-lohono-mcp.conf

# Review the generated config
cat /tmp/nginx-lohono-mcp.conf

# Install the config
sudo cp /tmp/nginx-lohono-mcp.conf /etc/nginx/sites-available/lohono-mcp
sudo ln -sf /etc/nginx/sites-available/lohono-mcp /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Start nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

**Alternative: Manual configuration**

If you prefer to manually create the config, see `docs/nginx-config-reference.conf` for the full template. The script-generated config is recommended for consistency.

### Step 14: Verify Nginx Proxy

```bash
# Test nginx is serving on port 80
curl http://localhost/health
# Should return: healthy

# Test API proxy
curl http://localhost/api/health
# Should return JSON from MCP Client

# Test web UI proxy
curl -I http://localhost/
# Should return 200 OK with HTML

# Check nginx is running and listening on port 80
sudo systemctl status nginx
sudo netstat -tlnp | grep :80
```

### Step 15: Configure DNS and SSL for ailabs.lohono.com

**1. Verify ALB is healthy:**
```bash
# From EC2 console, get your ALB DNS name
# Example: my-alb-1234567890.us-east-1.elb.amazonaws.com

# Test ALB is routing to your instance
curl -H "Host: ailabs.lohono.com" http://ALB_DNS_NAME/health
```

**2. Create SSL Certificate in AWS Certificate Manager (ACM):**

```bash
# Go to AWS Certificate Manager (ACM) in the AWS Console
# Make sure you're in the SAME REGION as your ALB
```

- Click **Request a certificate**
- Choose **Request a public certificate**
- Add domain name: `ailabs.lohono.com`
- Choose **DNS validation** (recommended) or **Email validation**
- Click **Request**

**For DNS validation:**
- ACM will provide a CNAME record
- Add this CNAME record to your Route 53 hosted zone for `lohono.com`
- Wait for validation (usually 5-30 minutes)
- Status should change to "Issued"

**3. Configure Route 53 DNS:**

- Go to **Route 53** → **Hosted zones** → `lohono.com`
- Create an **A record** with **Alias**:
  - **Record name**: `ailabs`
  - **Record type**: A - IPv4 address
  - **Alias**: Yes (toggle on)
  - **Route traffic to**: 
    - Choose "Alias to Application and Classic Load Balancer"
    - Select your region
    - Select your ALB from the dropdown
  - **Routing policy**: Simple routing
  - Click **Create records**

**4. Add HTTPS Listener to ALB:**

- Go to **EC2** → **Load Balancers** → Select your ALB
- Go to **Listeners** tab
- Click **Add listener**
  - **Protocol**: HTTPS
  - **Port**: 443
  - **Default action**: Forward to your target group (the one with your EC2 instance)
  - **Security policy**: ELBSecurityPolicy-TLS13-1-2-2021-06 (recommended)
  - **Default SSL/TLS certificate**: Select the certificate you created in ACM
- Click **Add**

**5. (Optional) Redirect HTTP to HTTPS:**

- In the **Listeners** tab, select the **HTTP:80** listener
- Click **Edit**
- Change the default action:
  - Remove the forward action
  - Add **Redirect** action:
    - **Protocol**: HTTPS
    - **Port**: 443
    - **Status code**: 301 (Permanent redirect)
- Click **Save**

**6. Verify SSL is working:**

```bash
# Wait 2-5 minutes for DNS propagation
# Test HTTPS access
curl https://ailabs.lohono.com/health

# Should return: healthy

# Test in browser
# Navigate to: https://ailabs.lohono.com
```

**7. Update Google OAuth Redirect URIs:**

Go back to your Google Cloud Console and update OAuth credentials:
- Authorized redirect URIs: `https://ailabs.lohono.com/auth/callback`

## Part 5: Configure Authentication

### Step 16: Set Up Google OAuth

The application uses Google OAuth for authentication.

**1. Create Google Cloud Project** (if not already done):
   - Go to https://console.cloud.google.com
   - Create new project or select existing project
   - Note the project ID

**2. Enable Required APIs**:
   - Navigate to **APIs & Services** → **Library**
   - Search for and enable:
     - **Google+ API** (for user profile)
     - **Google OAuth2 API**

**3. Configure OAuth Consent Screen**:
   - Go to **APIs & Services** → **OAuth consent screen**
   - User Type: **Internal** (if using Google Workspace) or **External**
   - Fill in required fields:
     - App name: "Lohono AI Database Context"
     - User support email: your-email@lohono.com
     - Authorized domains: `lohono.com`
   - Add scopes: `email`, `profile`, `openid`
   - Save and continue

**4. Create OAuth 2.0 Credentials**:
   - Go to **APIs & Services** → **Credentials**
   - Click **Create Credentials** → **OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Name: "Lohono MCP Web Client"
   - **Authorized JavaScript origins**:
     - `https://ailabs.lohono.com`
   - **Authorized redirect URIs**:
     - `https://ailabs.lohono.com/auth/callback`
     - `https://ailabs.lohono.com/auth/google/callback` (if using alternative callback)
   - Click **Create**
   - **Save the Client ID and Client Secret** - you'll need these

**5. Update Application Configuration**:

The OAuth credentials need to be configured in your application. Check where your web app expects these:

```bash
# Check if web app has environment config
ls lohono-chat-client/.env* lohono-chat-client/src/config*

# You may need to add these to .env or rebuild the web container with the credentials
```

If you need to add them to `.env`:
```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Then rebuild and restart the web container:
```bash
docker compose up -d --build web
```

### Step 17: Authorize Staff Users

Only users in the `staffs` table with `active = true` can access the system.

```bash
# Open database shell
make db-shell

# In psql, check existing staff
SELECT id, email, name, active FROM staffs LIMIT 10;

# Add a new staff user
INSERT INTO staffs (email, name, active) 
VALUES ('newuser@yourdomain.com', 'New User', true);

# Or activate an existing user
UPDATE staffs SET active = true WHERE email = 'user@yourdomain.com';

# Exit
\q
```

## Part 6: Monitoring and Maintenance

### Step 18: Set Up Monitoring

**View logs:**
```bash
# Real-time logs from all services
make logs

# Check specific service
make logs-mcp-client
```

**Enable observability stack (optional):**
```bash
# If you deployed with make deploy-all, SigNoz is already running
# Access at: http://YOUR_ELASTIC_IP:3301

# To enable traces and logs:
# Edit .env and set:
OTEL_SDK_DISABLED=false

# Restart services
docker compose up -d --build mcp-server mcp-client
```

### Step 19: Database Backups

**Manual backup:**
```bash
# Create backup
make db-backup

# This creates db/<timestamp>.sql.gz
```

**Automated daily backups with cron:**
```bash
# Edit crontab
crontab -e

# Add this line for daily backup at 2 AM
0 2 * * * cd /home/ubuntu/lohono-db-context && /usr/bin/docker compose exec -T postgres pg_dump -U lohono_api lohono_api_production | gzip > db/backup-$(date +\%Y\%m\%d-\%H\%M\%S).sql.gz

# Keep only last 7 days of backups (add another cron job)
0 3 * * * find /home/ubuntu/lohono-db-context/db -name "backup-*.sql.gz" -mtime +7 -delete
```

**Copy backups to S3 (recommended):**
```bash
# Install AWS CLI
sudo apt-get install -y awscli

# Configure AWS credentials
aws configure

# Add to cron for S3 sync after backup
30 2 * * * aws s3 sync /home/ubuntu/lohono-db-context/db s3://your-backup-bucket/lohono-db-backups/ --exclude "*" --include "backup-*.sql.gz"
```

### Step 20: Update Application

**To deploy new code changes:**
```bash
cd ~/lohono-db-context

# Pull latest changes
git pull origin main

# Rebuild and restart services
docker compose up -d --build

# Or rebuild specific service
docker compose up -d --build --no-deps mcp-client
```

**Zero-downtime updates:**
```bash
# Update one service at a time
docker compose up -d --build --no-deps mcp-server
docker compose up -d --build --no-deps mcp-client
docker compose up -d --build --no-deps web
```

## Part 7: Security Hardening

### Step 21: Additional Security Steps

**Firewall with UFW:**
```bash
# Enable UFW
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8080/tcp  # Or restrict to specific IPs
sudo ufw enable
```

**Automatic security updates:**
```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

**Docker security:**
```bash
# Limit log file sizes (edit /etc/docker/daemon.json)
sudo tee /etc/docker/daemon.json > /dev/null <<EOF
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

**Secure .env file:**
```bash
chmod 600 .env
```

### Step 22: Set Up Alerts (Optional)

**Monitor disk space:**
```bash
# Add to cron
crontab -e

# Alert if disk usage > 80%
0 * * * * df -h / | awk 'NR==2 {if (substr($5,1,length($5)-1) > 80) print "Disk usage alert: " $5}' | mail -s "Disk Alert" your@email.com
```

**Monitor Docker containers:**
```bash
# Check if containers are running
*/5 * * * * docker compose -f /home/ubuntu/lohono-db-context/docker-compose.yml ps | grep -q "Exit\|unhealthy" && echo "Container issue detected" | mail -s "Docker Alert" your@email.com
```

## Troubleshooting

### Common Issues

**1. Containers won't start:**
```bash
# Check logs
make logs

# Check Docker daemon
sudo systemctl status docker

# Restart Docker
sudo systemctl restart docker
docker compose up -d
```

**2. Out of memory:**
```bash
# Check memory usage
free -h
docker stats

# Consider upgrading to t3.2xlarge
# Or use managed databases (RDS + DocumentDB)
```

**3. Database connection errors:**
```bash
# Check if Postgres is healthy
docker compose ps postgres

# Test connection
docker compose exec postgres psql -U lohono_api -d lohono_api_production -c "SELECT 1;"

# Check logs
make logs-postgres
```

**4. Claude API errors:**
```bash
# Verify API key in .env
grep ANTHROPIC_API_KEY .env

# Check client logs
make logs-mcp-client | grep -i error
```

**5. Authentication failures:**
```bash
# Verify user exists and is active
make db-shell
SELECT email, active FROM staffs WHERE email = 'user@domain.com';
```

### Health Check Commands

```bash
# Quick health check of all services
curl -s http://localhost:3000/health && echo "✓ MCP Server" || echo "✗ MCP Server"
curl -s http://localhost:3001/api/health && echo "✓ MCP Client" || echo "✗ MCP Client"
curl -s http://localhost:8080 > /dev/null && echo "✓ Web UI" || echo "✗ Web UI"
```

## Cost Optimization

### Reduce Costs

1. **Use Spot Instances**: Can save up to 70% but may be interrupted
2. **Schedule shutdown**: If not 24/7, stop instance during off-hours
3. **Use t3a instead of t3**: ~10% cheaper, AMD processors
4. **Right-size after monitoring**: Start with t3.xlarge, downgrade if underutilized
5. **Use managed databases**: Offload operational burden, might be cost-neutral

### Cost Estimate (us-east-1)

**Option A: All-in-one EC2 (recommended for start)**
- t3.xlarge: ~$120/month
- 80 GB EBS gp3: ~$8/month
- Elastic IP: ~$3.6/month (if not attached to running instance)
- **Total: ~$130/month**

**Option B: With managed databases**
- t3.medium (apps only): ~$30/month
- RDS PostgreSQL db.t3.small: ~$35/month
- DocumentDB t3.medium: ~$70/month
- **Total: ~$135/month**

## Next Steps

After successful deployment:

1. ✅ Test the web UI and run sample queries
2. ✅ Configure automated backups to S3
3. ✅ Set up CloudWatch monitoring (optional)
4. ✅ Configure domain name and SSL
5. ✅ Set up log aggregation (CloudWatch Logs or SigNoz)
6. ✅ Document any custom configurations
7. ✅ Train team on usage and troubleshooting

## Support

- **Application logs**: `make logs`
- **Database shell**: `make db-shell`
- **Service status**: `make ps`
- **Restart services**: `make restart`
- **Full cleanup**: `make clean-all` (destructive!)

For issues, check the logs first and refer to the main README.md.
