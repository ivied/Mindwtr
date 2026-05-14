# Конкретные данные для настройки

## Что я знаю и могу дать

### Сервер
```
HOST:     204.168.252.77 (Hetzner cax21 ARM, Helsinki)
SSH alias: ssh hetzner-mfp        (твой ~/.ssh/config Host hetzner-mfp)
USER:     dev
WORKDIR:  /opt/gtd                (создашь в Step 1)
```

### Домен
```
Зона:   kurdy.uk на Cloudflare (NS: maeve.ns.cloudflare.com, vick.ns.cloudflare.com)
Subdomains:
  gtd.kurdy.uk      → mindwtr-app   internal port 5173
  api.gtd.kurdy.uk  → mindwtr-cloud internal port 8787
  ai.gtd.kurdy.uk   → ai-service    internal port 3030
```

**Текущее состояние DNS:** A/CNAME для `*.gtd.kurdy.uk` ПУСТЫЕ. Они появятся
автоматически когда создашь Cloudflare Tunnel routes в Step 2. CF делает
CNAME `<sub>.kurdy.uk → <tunnel-uuid>.cfargotunnel.com` сам.

### Cloudflare Tunnel
```
Создаётся:  https://one.dash.cloudflare.com → Networks → Tunnels
Имя:        gtd-prod
Connector:  Cloudflared (НЕ Argo, не Workers — именно Cloudflared)
Token:      даст CF после создания (длинная base64-строка)
            → положить в .env.prod как CLOUDFLARE_TUNNEL_TOKEN
```

### Аккаунты (из твоего ~/.ssh/config + docker/.env)
```
Hetzner:     sudorous@gmail.com  (https://console.hetzner.cloud)
Cloudflare:  тот же mail вероятно (https://one.dash.cloudflare.com)
GitHub:      sudorous (для ghcr.io если будем CI делать)
```

---

## Что генерируется ТОБОЙ (секреты, я их не знаю)

Запусти эти команды на Mac локально, скопируй результаты в `.env.prod`:

```bash
# Mindwtr cloud auth tokens — один для Mac capture-agent + локального dev,
# второй для phone PWA (чтобы можно было revoke отдельно)
openssl rand -hex 32
# → 9f8a3...
# → положить в MINDWTR_CLOUD_AUTH_TOKENS=<token1>,<token2>

# AI Service HTTP token — один на всю инфру (capture-agent + PWA + curl)
openssl rand -hex 32
# → положить в HTTP_AUTH_TOKEN=<token>
```

## Что копируется из существующего dev `.env`

`~/Projects/GTD_mindwtr/docker/.env` — все эти ключи **просто берёшь
оттуда** и кладёшь в `.env.prod` без изменений (они same между dev и prod):

```
TELEGRAM_BOT_TOKEN=<copy from dev>
LLM_BASE_URL=http://ec2-54-183-85-48.us-west-1.compute.amazonaws.com:20128/v1
LLM_API_KEY=<copy from dev>
LLM_MODEL=cc/claude-opus-4-6
OPENAI_API_KEY=<copy from dev>
OPENAI_BASE_URL=https://api.openai.com/v1
TG_NOTIFY_CHAT_ID=<copy from dev — 379278124>
SLACK_APP_TOKEN=<copy>     # если используешь
SLACK_BOT_TOKEN=<copy>
NOTION_API_KEY=<copy>
NOTION_DATABASE_ID=<copy>
```

Команда чтобы быстро посмотреть свои текущие значения:
```bash
grep -E "^(TELEGRAM_BOT_TOKEN|LLM_|OPENAI_|TG_NOTIFY|SLACK_|NOTION_|USER_IDENTITY)" \
  ~/Projects/GTD_mindwtr/docker/.env
```

---

## Cloudflare Tunnel — точная таблица routes для UI

В Cloudflare Zero Trust → Networks → Tunnels → gtd-prod → Public Hostname tab:

| Subdomain | Domain    | Path | Type | URL                       |
|-----------|-----------|------|------|---------------------------|
| `gtd`     | kurdy.uk  | *    | HTTP | `mindwtr-app:5173`        |
| `api`     | kurdy.uk  | *    | HTTP | `mindwtr-cloud:8787`      |
| `ai`      | kurdy.uk  | *    | HTTP | `ai-service:3030`         |

Дополнительные settings под "Additional application settings" для каждого:
- TLS → No TLS Verify: можно оставить как есть (соединение внутри docker
  network — без TLS).
- HTTP → No happy eyeballs, HTTP Host Header: пусто (cloudflared сам
  обрабатывает).

**Что увидишь на DNS-странице kurdy.uk после Save:**
```
CNAME  gtd      <uuid>.cfargotunnel.com   Proxied  (orange cloud)
CNAME  api      <uuid>.cfargotunnel.com   Proxied
CNAME  ai       <uuid>.cfargotunnel.com   Proxied
```

`<uuid>` — UUID твоего туннеля, появится автоматически.

---

## Cloudflare Access (опционально, для extra security)

Поверх bearer-auth на API можно добавить **CF Access** на UI:

CF Zero Trust → Access → Applications → Add an application → Self-hosted:
- Application domain: `gtd.kurdy.uk`
- Identity providers: Google / GitHub / one-time PIN на ваш email
- Session duration: 30 дней
- Policy: только твой email

Это даст cookies-based auth на главный UI: открыл gtd.kurdy.uk, CF
показала экран "Sign in with Google" → залогинился → дальше нормально.
Для API endpoints (`api.gtd.kurdy.uk`, `ai.gtd.kurdy.uk`) **не** включать —
там bearer-auth и они должны быть machine-callable.

Это можно сделать **позже** — на v1 hop'нуть, на v2 включить когда
поделишься URL'ом с кем-то.

---

## Минимальный `.env.prod` для копипасты (без секретов)

```bash
cat > /opt/gtd/.env.prod <<'EOF'
# Заполнить значения CHANGEME

GHCR_OWNER=sudorous
IMAGE_TAG=latest

MINDWTR_CLOUD_AUTH_TOKENS=CHANGEME_TOKEN1,CHANGEME_TOKEN2
MINDWTR_CLOUD_CORS_ORIGIN=https://gtd.kurdy.uk

HTTP_AUTH_TOKEN=CHANGEME_HTTP_TOKEN
HTTP_CORS_ORIGINS=https://gtd.kurdy.uk

TELEGRAM_BOT_TOKEN=CHANGEME_FROM_DEV_ENV
TG_NOTIFY_CHAT_ID=379278124

USER_IDENTITY_NAME=Sergey Kurdyuk
USER_IDENTITY_ALIASES=Sergey,Сергей,Серёга,Sergey KTR

LLM_BASE_URL=http://ec2-54-183-85-48.us-west-1.compute.amazonaws.com:20128/v1
LLM_API_KEY=CHANGEME_FROM_DEV_ENV
LLM_MODEL=cc/claude-opus-4-6

OPENAI_API_KEY=CHANGEME_FROM_DEV_ENV
OPENAI_BASE_URL=https://api.openai.com/v1
EMBEDDINGS_MODEL=text-embedding-3-small

CLOUDFLARE_TUNNEL_TOKEN=CHANGEME_FROM_CF_DASHBOARD

GTD_DATA_ROOT=/opt/gtd
PROACTIVE_INTERVAL_MS=21600000
CONTEXT_STORE_TTL_DAYS=7
EOF

chmod 600 /opt/gtd/.env.prod
```

---

## Health-check команды (чтобы проверить что работает)

После Step 5 в SETUP.md:

```bash
# 1. На VPS — все 4 контейнера up
ssh hetzner-mfp 'cd /opt/gtd && docker compose -f compose.prod.yaml ps'

# Ожидаемый вывод:
# gtd-cloudflared       Up
# gtd-mindwtr-cloud     Up (healthy)
# gtd-mindwtr-app       Up
# gtd-ai-service        Up

# 2. CF Tunnel здоров (из браузера или curl)
curl -sI https://gtd.kurdy.uk/                          # 200 или 302
curl -sI https://api.gtd.kurdy.uk/health                # 200
curl -sI https://ai.gtd.kurdy.uk/health                 # 200

# 3. Mindwtr API авторизован
curl -s -H "Authorization: Bearer <первый MINDWTR_TOKEN>" \
  https://api.gtd.kurdy.uk/v1/tasks?status=inbox&limit=1

# 4. AI Service отдаёт memory stats
curl -s -H "Authorization: Bearer <HTTP_AUTH_TOKEN>" \
  https://ai.gtd.kurdy.uk/v1/memory/stats
# → {"events":N,"facts":N,...}
```

---

## TL;DR — что от тебя нужно

1. **Hetzner:** ничего — сервер уже есть, доступ через `ssh hetzner-mfp`
2. **Домен:** ничего — kurdy.uk уже на CF, DNS появится через CF Tunnel автоматически
3. **3 секрета сгенерировать** локально через `openssl rand -hex 32`
4. **Один Cloudflare Tunnel создать** в dashboard, скопировать token
5. **Скопировать существующие** TG/LLM/OpenAI ключи из dev `.env` в `.env.prod`
6. **Запустить** деплой по `SETUP.md`

Время на сетап: **15-30 мин** при первом проходе.
