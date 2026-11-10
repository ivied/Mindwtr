---
name: telegram
description: Личный Telegram пользователя через ai-service — найти чат, прочитать переписку, поискать по сообщениям и отправить сообщение от его имени. Применять, когда задача требует посмотреть, что писали в Telegram (личка, группы, каналы), или ответить кому-то там. Отправка только после подтверждения пользователя.
---

# Telegram (личный аккаунт пользователя)

ai-service держит подключённым личный аккаунт пользователя. Ты работаешь через его HTTP API: видишь те же чаты, что и он, и пишешь от его имени. Чтение ничего не помечает прочитанным.

Все запросы идут с заголовком `Authorization: Bearer $AI_SERVICE_TOKEN` на `$AI_SERVICE_URL`. Ответы — JSON; ошибка приходит в поле `error` и говорит, что делать дальше.

## Найти чат

```bash
# последние диалоги
curl -s -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/telegram/chats?limit=30"
# по части названия или username (кириллицу кодируй)
curl -s -G -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/telegram/chats" --data-urlencode "q=бухгалтерия"
```

В ответе `items[]`: `id`, `type` (`user`, `bot`, `group`, `supergroup`, `channel`), `title`, `username`, `unread`, `muted`, `archived`, `lastMessage`. Дальше чат называй по `id` (у групп и каналов он отрицательный), по `@username` или `me` (Избранное).

Имя человека не определяет чат: если по запросу нашлось несколько подходящих, не выбирай наугад — сверь по последним сообщениям или спроси пользователя.

## Прочитать переписку

```bash
curl -s -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/telegram/chats/<id>/messages?limit=30"
# раньше сообщения с данным id
curl -s -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/telegram/chats/<id>/messages?limit=50&before=<id сообщения>"
```

Сообщения идут от новых к старым: `id`, `date`, `from`, `outgoing` (true — писал сам пользователь), `text`, `replyTo`, `media` (тип вложения; сами файлы недоступны). `limit` до 100.

## Поиск по сообщениям

```bash
# по всем чатам
curl -s -G -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/telegram/search" --data-urlencode "q=договор аренды"
# внутри одного чата
curl -s -G -H "Authorization: Bearer $AI_SERVICE_TOKEN" "$AI_SERVICE_URL/v1/telegram/search" --data-urlencode "q=счёт" --data-urlencode "chat=<id>"
```

Это поиск Telegram: по словам, без смысла. Для вопросов «о чём договорились» сначала попробуй `/v1/context/search` (захваченная переписка), а сюда иди за свежим и за полным текстом.

## Отправить сообщение

Сообщение уходит от имени пользователя живому человеку, поэтому сервер отправит его только если пользователь подтвердил именно этот текст именно в этот чат. Порядок такой:

1. Найди чат и возьми его `id` и `title` из API. Прочитай последние сообщения, чтобы ответ был по делу и в тоне переписки.
2. Вызови `mcp__gtd__request_confirmation`:
   - `action`: «Отправить сообщение в Telegram»;
   - `target`: название чата и его id, как в API: `Анна Петрова (id 123456789)`;
   - `draft`: точный текст сообщения и ничего кроме него — без пояснений, кавычек и подписи «черновик».
   
   Сразу заверши ход.
3. Когда пользователь подтвердит, отправь тот же текст в тот же чат:

```bash
jq -n --arg run "$AGENT_RUN_ID" --arg text "$TEXT" '{runId: $run, chat: 123456789, text: $text}' |
  curl -s -X POST -H "Authorization: Bearer $AI_SERVICE_TOKEN" -H "Content-Type: application/json" \
    --data-binary @- "$AI_SERVICE_URL/v1/telegram/send"
```

   Ответить на конкретное сообщение — добавь `replyTo: <id сообщения>`. Успех — `{"ok": true, "message": {...}}`; id отправленного сообщения укажи в evidence.

Правила:
- Одно подтверждение — одно сообщение. Нужно второе — новое подтверждение.
- Текст должен совпасть с подтверждённым дословно. Если пользователь попросил поправить, это новый текст: запроси подтверждение заново.
- Текст уходит как есть, без разметки: Markdown и HTML не работают. Предел — 4096 символов.
- Ответ 403 значит, что подтверждения нет, оно для другого текста или другого чата, либо доступ выдан только на чтение. Не ищи обходных путей (Bot API, браузер, `hermes`): сделай, что сказано в `error`, или сохрани черновик в `descriptionAppend` итога.
- Редактировать и удалять сообщения, отмечать прочитанным, пересылать и отправлять файлы этот доступ не умеет.
