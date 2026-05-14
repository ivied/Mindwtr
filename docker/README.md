# Mindwtr Docker (PWA + Cloud)

This folder contains Dockerfiles and a compose file to run:
- **mindwtr-app**: the desktop web/PWA build, served by Nginx
- **mindwtr-cloud**: the lightweight sync server

## Quick start (HTTP compose)

```bash
export MINDWTR_CLOUD_AUTH_TOKENS=your_token_here
export MINDWTR_CLOUD_CORS_ORIGIN=http://localhost:5173
docker compose -f docker/compose.yaml up --build
```

Then open:
- PWA: `http://localhost:5173`
- Cloud health: `http://localhost:8787/health`
- Self-Hosted URL for local testing: `http://localhost:8787`
- REST API base URL: `http://localhost:8787/v1`

This HTTP compose file is best for local testing. Mindwtr desktop and mobile clients accept HTTP for localhost, private IPs, and local hostnames. Public URLs should use HTTPS.

## HTTPS quick start (Cloud + Caddy)

Use the HTTPS compose file when syncing real desktop or mobile clients to a self-hosted cloud server:

```bash
cp docker/.env.https.example docker/.env.https.local
```

Edit `docker/.env.https.local`:

```dotenv
MINDWTR_CLOUD_DOMAIN=mindwtr.example.com
MINDWTR_CLOUD_AUTH_TOKENS=your_long_random_token
MINDWTR_CLOUD_CORS_ORIGIN=https://mindwtr.example.com
MINDWTR_CADDYFILE=Caddyfile.https
```

Start the HTTPS stack:

```bash
docker compose --env-file docker/.env.https.local -f docker/compose.https.yaml up -d
```

Then check:

```bash
curl https://mindwtr.example.com/health
```

In Mindwtr Settings -> Sync -> Self-Hosted, use:

```text
https://mindwtr.example.com
```

Mindwtr will automatically append `/v1/data`.

### LAN-only HTTPS

For a hostname that only resolves on your home network, change:

```dotenv
MINDWTR_CLOUD_DOMAIN=mindwtr.home.arpa
MINDWTR_CLOUD_CORS_ORIGIN=https://mindwtr.home.arpa
MINDWTR_CADDYFILE=Caddyfile.local-https
```

This uses Caddy's internal certificate authority. Each client device must trust Caddy's local root certificate before Mindwtr will accept the HTTPS connection. Public Let's Encrypt certificates are the more reliable option for mobile clients.

After the LAN-only stack starts, you can export Caddy's local root certificate with:

```bash
docker compose --env-file docker/.env.https.local -f docker/compose.https.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./mindwtr-caddy-root.crt
```

Install that certificate as a trusted root on each device that will sync to this hostname.

## Configure sync token

The cloud server expects a token. In `docker/compose.yaml`, set:

```
MINDWTR_CLOUD_AUTH_TOKENS=your_token_here
```

`MINDWTR_CLOUD_TOKEN` is still accepted for backward compatibility, but deprecated.

For Docker secrets, you can point to a mounted file instead:

```
MINDWTR_CLOUD_AUTH_TOKENS_FILE=/run/secrets/mindwtr_cloud_tokens
```

Use the **same token** in Mindwtr Settings → Sync → Self-Hosted.
Set the Self-Hosted URL to the **base** endpoint, for example:

```
http://localhost:8787
```

Mindwtr will automatically append `/v1/data` and store `data.json` (and attachments) under that endpoint.

Example to generate a token:

```
cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | fold -w 50 | head -n 1
```

Or you can use https://it-tools.tech/token-generator

## API (task automation)

The cloud container now exposes the REST API on the same host/port as sync, using the **same Bearer token**.

Base URL:

```
http://localhost:8787/v1
```

Create a task:

```
curl -X POST \
  -H "Authorization: Bearer your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"input":"Review invoice from Paperless /due:tomorrow #finance"}' \
  http://localhost:8787/v1/tasks
```

List tasks:

```
curl -H "Authorization: Bearer your_token_here" \
  "http://localhost:8787/v1/tasks?status=next"
```

## Volumes

Persist cloud data by mounting a host path:

```
./data:/app/cloud_data
```

If you switch to a custom host path, make sure it is writable by the container user (uid 1000):

```
sudo chown -R 1000:1000 /path/data_dir
```

## Build without compose (optional)

```bash
# PWA
docker build -f docker/app/Dockerfile -t mindwtr-app .

# Cloud
docker build -f docker/cloud/Dockerfile -t mindwtr-cloud .
```

## Notes

- The PWA uses client-side rendering; Nginx is configured with `try_files` to avoid 404s on refresh.
- Bun is pinned to `1.3` and the build uses C++20 flags for `better-sqlite3`.
