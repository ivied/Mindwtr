# Docker Deployment

Mindwtr provides official Docker support for running:
- **mindwtr-app**: The desktop web/PWA build, served by Nginx.
- **mindwtr-cloud**: The lightweight sync server and task automation REST API.

These are available as Docker images and can be easily orchestrated using Docker Compose.

---

## Quick Start (Docker Compose)

The easiest way to get started locally is using the `compose.yaml` file included in the `docker/` directory of the repository.

1. **Clone the repository** (if you haven't already):
   ```bash
   git clone https://github.com/dongdongbh/Mindwtr.git
   cd Mindwtr
   ```

2. **Set local HTTP configuration**:
   ```bash
   export MINDWTR_CLOUD_AUTH_TOKENS=your_token_here
   export MINDWTR_CLOUD_CORS_ORIGIN=http://localhost:5173
   ```

3. **Start the services**:
   ```bash
   docker compose -f docker/compose.yaml up --build -d
   ```

4. **Access the services**:
   - **PWA (Web App):** Open `http://localhost:5173` in your browser.
   - **Cloud Health Check:** Open `http://localhost:8787/health`.
   - **Self-Hosted URL for local testing:** `http://localhost:8787`
   - **REST API Base URL:** `http://localhost:8787/v1`

This default compose file is HTTP-only and intended for local/private testing. Mindwtr desktop and mobile clients accept HTTP only for recognized local/private targets such as `localhost`, `127.0.0.1`, `10.x.x.x`, `172.16.x.x` through `172.31.x.x`, `192.168.x.x`, loopback/private IPv6 addresses, `*.local`, and `*.home.arpa`.

For public URLs, custom DNS names, VPN hostnames, Tailscale, ZeroTier, or any name that is not recognized as local/private, use HTTPS. The **Allow insecure connections (HTTP)** setting is a compatibility setting for trusted local/private endpoints; it is not a public HTTP override.

---

## HTTPS Setup with Caddy

For public desktop or mobile sync, use the Caddy-backed compose file:

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

Start the stack:

```bash
docker compose --env-file docker/.env.https.local -f docker/compose.https.yaml up -d
```

Check the server:

```bash
curl https://mindwtr.example.com/health
```

In Mindwtr Settings -> Sync -> Self-Hosted, set the Self-Hosted URL to:

```text
https://mindwtr.example.com
```

Mindwtr will automatically append `/v1/data`.

### Public HTTPS

Use `Caddyfile.https` when `MINDWTR_CLOUD_DOMAIN` is a public DNS name that points to this Docker host. Ports 80 and 443 must be reachable for automatic certificate issuance. Caddy obtains the certificate, renews it, and reverse-proxies requests to `mindwtr-cloud`.

### LAN-only HTTPS

Use `Caddyfile.local-https` when the hostname only resolves on your home network:

```dotenv
MINDWTR_CLOUD_DOMAIN=mindwtr.home.arpa
MINDWTR_CLOUD_CORS_ORIGIN=https://mindwtr.home.arpa
MINDWTR_CADDYFILE=Caddyfile.local-https
```

This uses Caddy's internal certificate authority. Each client device must trust Caddy's local root certificate before Mindwtr will accept the HTTPS connection. Public Let's Encrypt certificates are the more reliable option for mobile clients.

After the LAN-only stack starts, export Caddy's local root certificate:

```bash
docker compose --env-file docker/.env.https.local -f docker/compose.https.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./mindwtr-caddy-root.crt
```

Install that certificate as a trusted root on each device that will sync to this hostname.

---

## Configuration

### Sync Token
The cloud server requires a token for authentication. You need to set this in the environment variables.

In `docker/compose.yaml` (or via environment variable), set:

```yaml
MINDWTR_CLOUD_AUTH_TOKENS=your_token_here
```

`MINDWTR_CLOUD_TOKEN` is still accepted for backward compatibility, but deprecated.

For Docker secrets, you can mount a file and point to it instead:

```yaml
MINDWTR_CLOUD_AUTH_TOKENS_FILE: /run/secrets/mindwtr_cloud_tokens
```

**Generating a Token:**
You can generate a strong random token using:
```bash
cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | fold -w 50 | head -n 1
```

### Client Configuration
To connect your Mindwtr clients (Desktop or Mobile) to this self-hosted cloud:

1. Go to **Settings → Sync**.
2. Select **Self-Hosted** (or Cloud).
3. Set the **Self-Hosted URL** to your server's base endpoint:
   ```
   http://localhost:8787
   ```
   *Mindwtr will automatically append `/v1/data` to this URL.*
4. Enter the **same token** you configured in `MINDWTR_CLOUD_AUTH_TOKENS`.

For private LAN HTTP, use a local/private address such as `http://192.168.1.20:8787`. For public URLs, use the Caddy HTTPS setup above.

### Task Automation API

The same `mindwtr-cloud` container also exposes the REST API for task automation. It uses the same base URL and the same bearer token as sync.

Common endpoints:

- `GET /v1/data` and `PUT /v1/data` for sync
- `GET /v1/tasks` and `POST /v1/tasks` for task listing and creation
- `GET /v1/projects` for projects
- `GET /v1/search?query=...` for task and project search

Example:

```bash
curl -X POST http://localhost:8787/v1/tasks \
  -H "Authorization: Bearer your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"input":"Review PR @work /due:tomorrow"}'
```

### CORS Origin (Production)

The cloud server defaults to `http://localhost:5173` for CORS. For production, set:

```yaml
MINDWTR_CLOUD_CORS_ORIGIN=https://your-app-domain.example
```

---

## Data Persistence

To keep your cloud data safe across container restarts, you should mount a volume for the data directory.

In your `compose.yaml`:

```yaml
volumes:
  - ./data:/app/cloud_data
```

---

## Building Manually

If you prefer to build the images yourself without Compose:

**Build PWA:**
```bash
docker build -f docker/app/Dockerfile -t mindwtr-app .
```

**Build Cloud Server:**
```bash
docker build -f docker/cloud/Dockerfile -t mindwtr-cloud .
```

---

## GitHub Actions & GHCR

The project includes a GitHub Actions workflow that automatically builds and pushes images to the GitHub Container Registry (GHCR).

**Official Images:**
- `ghcr.io/dongdongbh/mindwtr-app:latest`
- `ghcr.io/dongdongbh/mindwtr-cloud:latest`

The `docker/compose.yaml` file is configured to use these images by default, making it easy to pull the latest version without building locally.

---

## Technical Notes

- **PWA Serving:** The web app uses client-side rendering. The Nginx container is configured with `try_files` to redirect all requests to `index.html`, preventing 404 errors on page refresh.
- **Base Image:** The build uses Bun (pinned to v1.3) and includes C++20 flags required for `better-sqlite3`.
