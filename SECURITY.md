# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub security advisories](https://github.com/dongdongbh/Mindwtr/security/advisories/new). Do not open a public issue for anything exploitable.

You can expect an initial response within a few days. There is no bug bounty; fixes are credited in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Older tags are immutable and are never patched in place — a fix always ships as a new version.

## Supply-chain posture

- GitHub Actions are pinned to full commit SHAs.
- CI and release builds install dependencies with `bun install --frozen-lockfile`; the committed `bun.lock` is the source of truth.
- A scheduled dependency audit workflow reviews advisories for the dependency tree.
- Install scripts from dependencies are only expected for native builds (for example `better-sqlite3` in the cloud/MCP Docker images); new dependencies that need install scripts get extra review.

## Scope notes

Mindwtr is local-first. The optional self-hosted cloud server authenticates with bearer tokens (hashed at rest, constant-time comparison) and is the main network-exposed surface; reports about it are especially welcome.
