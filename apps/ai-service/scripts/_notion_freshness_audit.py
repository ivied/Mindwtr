"""Read-only Notion audit: which databases are still alive?

Walks every object the integration can see and buckets edits by year, then
splits databases into "живые" (edited within the freshness window) and
"мёртвые". Used to decide which databases are worth feeding into the capture
pipeline — the integration sees far more than is worth polling.

    NOTION_API_KEY=ntn_... python3 scripts/_notion_freshness_audit.py [days]
"""

import json, urllib.request, collections, sys, time, os, datetime

key = os.environ.get('NOTION_API_KEY', '')
if not key:
    raise SystemExit('NOTION_API_KEY is required')
H = {'Authorization': 'Bearer ' + key, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json'}


def search(cursor=None):
    body = {'page_size': 100}
    if cursor:
        body['start_cursor'] = cursor
    for attempt in range(5):
        try:
            req = urllib.request.Request('https://api.notion.com/v1/search', data=json.dumps(body).encode(), headers=H)
            return json.load(urllib.request.urlopen(req))
        except Exception as e:
            print(f'retry {attempt}: {e}', file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    raise SystemExit('search failed after retries')


dbs = {}
db_last_edit = collections.defaultdict(str)
db_pages = collections.Counter()
db_recent_90d = collections.Counter()
buckets = collections.Counter()
total = 0
cursor = None
WINDOW_DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 90
CUTOFF_90 = (datetime.date.today() - datetime.timedelta(days=WINDOW_DAYS)).isoformat()

while True:
    res = search(cursor)
    for r in res['results']:
        total += 1
        edited = r.get('last_edited_time', '')[:10]
        if r['object'] == 'database':
            title = ''.join(t['plain_text'] for t in r.get('title', [])).strip() or '(без названия)'
            dbs[r['id']] = title
            if edited > db_last_edit[r['id']]:
                db_last_edit[r['id']] = edited
        else:
            p = r.get('parent', {})
            dbid = p.get('database_id')
            if dbid:
                db_pages[dbid] += 1
                if edited > db_last_edit[dbid]:
                    db_last_edit[dbid] = edited
                if edited >= CUTOFF_90:
                    db_recent_90d[dbid] += 1
        year = edited[:4] or '????'
        buckets[year] += 1
    if not res.get('has_more'):
        break
    cursor = res['next_cursor']

print('total objects:', total)
print()
print('=== Правки по годам (все объекты) ===')
for y in sorted(buckets):
    print(f'  {y}: {buckets[y]}')
print()
print('=== Живые базы (правки за окно свежести), по числу свежих страниц ===')
rows = [(db_recent_90d[i], db_pages[i], db_last_edit[i], dbs.get(i, '?'), i) for i in dbs if db_recent_90d[i] > 0]
for fresh, pages, last, title, i in sorted(rows, reverse=True):
    print(f'  fresh90={fresh:5d}  total={pages:5d}  last={last}  {title}  {i}')
print()
print('=== Мёртвые базы (нет правок в окне) ===')
dead = [(db_last_edit[i], db_pages[i], dbs.get(i, '?'), i) for i in dbs if db_recent_90d[i] == 0]
for last, pages, title, i in sorted(dead, reverse=True):
    print(f'  last={last or "-"}  total={pages:5d}  {title}  {i}')
