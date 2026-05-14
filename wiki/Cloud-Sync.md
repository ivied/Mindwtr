# Cloud Sync (Self-Hosted)

> This standalone page is deprecated as a primary doc. Use the canonical pages below depending on what you are trying to do.

Mindwtr's self-hosted cloud backend is a small sync server under `apps/cloud`. It is a sync endpoint for desktop/mobile clients, not the Mindwtr app UI.

## Canonical Pages

- Use [[Data and Sync]] for choosing a sync backend and configuring the client.
- Use [[Cloud Deployment]] for server setup, operations, and environment variables.
- Use [[Cloud API]] for `/v1` endpoint details.
- Use [[Docker Deployment]] if you want the Docker-based deployment path.

## Quick Orientation

- The self-hosted cloud backend stores one JSON namespace per bearer token.
- Clients point at the `/v1` base URL and sync through `GET/PUT /v1/data`.
- `/v1/data` is the canonical sync contract; task, project, area, section, search, and attachment routes are optional convenience APIs.
- Attachment APIs live under `/v1/attachments/...`.
- Deploy it behind HTTPS and treat the bearer token like a password.
- HTTPS is required for public URLs. HTTP is accepted only for local/private targets such as `localhost`, `127.0.0.1`, `10.x.x.x`, `172.16.x.x` through `172.31.x.x`, `192.168.x.x`, loopback/private IPv6 addresses, `*.local`, and `*.home.arpa`.
- Use HTTPS for custom DNS, VPN hostnames, Tailscale, ZeroTier, and any name that is not recognized as local/private. The **Allow insecure connections (HTTP)** setting is a compatibility setting for trusted local/private endpoints; it is not a public HTTP override.

Keep this page only as a redirect for older links and bookmarks.

## See Also

- [[Data and Sync]]
- [[Cloud API]]
- [[Cloud Deployment]]
- [[Docker Deployment]]
- [[Dropbox Sync]]
