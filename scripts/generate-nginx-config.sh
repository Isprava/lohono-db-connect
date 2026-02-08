#!/bin/bash
# Generate nginx configuration for production deployment
# This script reads environment variables and generates the appropriate nginx config

set -e

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Defaults
PUBLIC_DOMAIN=${PUBLIC_DOMAIN:-ailabs.lohono.com}
WEB_PORT=${WEB_PORT:-8080}
CLIENT_PORT=${CLIENT_PORT:-3001}

OUTPUT_FILE=${1:-/tmp/nginx-lohono-mcp.conf}

echo "Generating nginx configuration..."
echo "  Domain: $PUBLIC_DOMAIN"
echo "  Web UI container: localhost:$WEB_PORT"
echo "  API container: localhost:$CLIENT_PORT"
echo "  Output: $OUTPUT_FILE"

cat > "$OUTPUT_FILE" << 'EOF'
# Nginx Configuration for Lohono MCP Platform
# Auto-generated - Do not edit manually
# Generated on: $(date)

# Upstream definitions for Docker services
upstream mcp_web {
    server localhost:${WEB_PORT};
    keepalive 32;
}

upstream mcp_api {
    server localhost:${CLIENT_PORT};
    keepalive 32;
}

# Main application server - ${PUBLIC_DOMAIN}
server {
    listen 80;
    listen [::]:80;
    
    server_name ${PUBLIC_DOMAIN};
    
    # Client max body size (for file uploads if any)
    client_max_body_size 10M;
    
    # Logging
    access_log /var/log/nginx/ailabs-access.log;
    error_log /var/log/nginx/ailabs-error.log warn;
    
    # Health check endpoint for ALB Target Group
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
    
    # API endpoints - proxy to MCP Client (port ${CLIENT_PORT})
    # This handles all API calls from the web UI to the backend
    location /api/ {
        proxy_pass http://mcp_api;
        proxy_http_version 1.1;
        
        # WebSocket support (if needed for real-time features)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        
        # Extended timeouts for Claude API calls (can take 30s-5min)
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        
        # Disable buffering for streaming responses
        proxy_buffering off;
        proxy_cache_bypass $http_upgrade;
        
        # CORS headers (if needed for cross-origin requests)
        add_header 'Access-Control-Allow-Origin' '$http_origin' always;
        add_header 'Access-Control-Allow-Credentials' 'true' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Accept,Authorization,Cache-Control,Content-Type,DNT,If-Modified-Since,Keep-Alive,Origin,User-Agent,X-Requested-With' always;
        
        # Handle preflight OPTIONS requests
        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }
    
    # Web UI - proxy to web container (port ${WEB_PORT})
    # This serves the React application and all static assets
    location / {
        proxy_pass http://mcp_web;
        proxy_http_version 1.1;
        
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Cache static assets (JS, CSS, images)
        proxy_cache_bypass $http_upgrade;
        
        # Standard timeouts for web content
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # Security: Deny access to hidden files
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}

# Default server block - return 444 for requests to IP or unknown domains
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    
    # Health check for ALB (in case it hits the default server)
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
    
    # Reject all other requests
    location / {
        return 444;
    }
}
EOF

# Perform environment variable substitution
eval "cat << EOFINNER
$(cat "$OUTPUT_FILE")
EOFINNER
" > "$OUTPUT_FILE"

echo "✓ Nginx configuration generated: $OUTPUT_FILE"
echo ""
echo "To deploy on server:"
echo "  sudo cp $OUTPUT_FILE /etc/nginx/sites-available/lohono-mcp"
echo "  sudo ln -sf /etc/nginx/sites-available/lohono-mcp /etc/nginx/sites-enabled/"
echo "  sudo nginx -t"
echo "  sudo systemctl reload nginx"
