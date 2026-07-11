#!/bin/bash

# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install docker-compose-plugin -y

# Install certbot for SSL
sudo apt install certbot -y

# Clone your repo
git clone https://github.com/YOUR_USERNAME/wax-prep.git
cd wax-prep

# Create environment file
cp .env.example .env
# Edit .env with your real values
nano .env

# Start everything
sudo docker compose -f docker-compose.prod.yml up --build -d

# Get SSL certificate (replace with your domain)
sudo certbot certonly --webroot -w ./certbot/www -d your-domain.com

# Reload nginx to pick up SSL
sudo docker compose -f docker-compose.prod.yml restart nginx

echo "Wax Prep Gateway is live."
