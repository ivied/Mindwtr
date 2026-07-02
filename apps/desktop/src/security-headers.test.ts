import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const headers = readFileSync(join(process.cwd(), 'public/_headers'), 'utf8');

describe('desktop static security headers', () => {
  it('ships a CSP for hosted PWA builds without inline scripts or embeddable content', () => {
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).toContain("script-src 'self'");
    expect(headers).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("frame-src 'none'");
    expect(headers).toContain("base-uri 'self'");
  });

  it('keeps browser hardening headers with the static CSP', () => {
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=()');
  });
});
