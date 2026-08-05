import { useEffect, useMemo, useRef, useState } from 'react';
import { useTaskStore } from '@mindwtr/core';
import { getDashboardStatus, getSourcePulse, setCapturePaused, isControlCenterAvailable, type DashboardStatus, type SourceKey } from '../../lib/control-center-client';

/**
 * Control Center — "Night Observatory" design (variant A).
 *
 * Phase 1: visual shell with placeholder data, ported from the static
 * prototype in GTD_automation/docs/design/control-center/. The view owns a
 * fully-scoped dark palette (teal=life, amber=attention) that intentionally
 * does NOT follow the app's theme tokens — per the design brief this section
 * is the visual flagship and sets its own language. It is dark-only and does
 * not react to the app theme switcher.
 *
 * Live data wiring (/health, /v1/memory/stats, /v1/procedural/stats,
 * recordings, @ai-agent tasks) is Phase 2; toggles + trust levels need new
 * backend (Phase 3) and are shown as visible-but-inert "скоро".
 */

type DemoState = '' | 'paused' | 'attention';

const ASSET = (name: string) => `/control-center/${name}`;

interface Src {
  key: SourceKey;
  name: string;
  shortName: string;
  asset: string;
  // position in the scene (fractions of the scene box)
  x: number;
  y: number;
  // true = source configured/available; notes has no Notion wired yet
  configured: boolean;
}

const SOURCES: Src[] = [
  { key: 'screen', name: 'Экран', shortName: 'Экран', asset: 'source-screen-t.png', x: 0.07, y: 0.10, configured: true },
  { key: 'audio', name: 'Звук', shortName: 'Звук', asset: 'source-audio-t.png', x: 0.03, y: 0.34, configured: true },
  { key: 'chat', name: 'Slack', shortName: 'Slack', asset: 'source-chat-t.png', x: 0.05, y: 0.58, configured: true },
  { key: 'telegram', name: 'Telegram', shortName: 'Telegram', asset: 'source-chat-t.png', x: 0.10, y: 0.78, configured: true },
  { key: 'notes', name: 'Заметки', shortName: 'Заметки', asset: 'source-notes-t.png', x: 0.26, y: 0.87, configured: false },
];

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} сек назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export function ControlCenterView() {
  const [tab, setTab] = useState<'dash' | 'caps'>('dash');
  const [demo, setDemo] = useState<DemoState>('');
  const [srcCard, setSrcCard] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(false);
  // per-source recent counts (last 10m) — drives thread brightness/dim only
  const ratesRef = useRef<Record<SourceKey, number>>({ screen: 0, audio: 0, chat: 0, telegram: 0, notes: 0 });
  // particles queued to emit, one per real arrival (drained by the canvas)
  const pendingRef = useRef<Record<SourceKey, number>>({ screen: 0, audio: 0, chat: 0, telegram: 0, notes: 0 });

  // ── live dashboard data (Phase 2) ──
  const [live, setLive] = useState<DashboardStatus | null>(null);
  const [, forceTick] = useState(0);

  // feed live source activity into the animation ref (no canvas restart)
  useEffect(() => {
    if (live?.sources) {
      ratesRef.current = {
        screen: live.sources.screen?.recent ?? 0,
        audio: live.sources.audio?.recent ?? 0,
        chat: live.sources.chat?.recent ?? 0,
        telegram: live.sources.telegram?.recent ?? 0,
        notes: live.sources.notes?.recent ?? 0,
      };
    }
  }, [live]);

  useEffect(() => {
    if (!isControlCenterAvailable()) return;
    let stop = false;
    let ctl: AbortController | null = null;
    const poll = async () => {
      ctl = new AbortController();
      try {
        const d = await getDashboardStatus(ctl.signal);
        if (!stop) setLive(d);
      } catch { /* keep last good; UI shows placeholders */ }
    };
    poll();
    const id = window.setInterval(poll, 8000);
    // re-render the relative "N назад" label every 15s without refetching
    const relId = window.setInterval(() => !stop && forceTick((n) => n + 1), 15000);
    return () => { stop = true; ctl?.abort(); clearInterval(id); clearInterval(relId); };
  }, []);

  // ── source pulse: queue one particle per REAL arrival since last cursor ──
  useEffect(() => {
    if (!isControlCenterAvailable()) return;
    let stop = false;
    let cursor: string | null = null; // first call seeds the cursor, emits nothing
    let ctl: AbortController | null = null;
    const poll = async () => {
      ctl = new AbortController();
      try {
        const p = await getSourcePulse(cursor, ctl.signal);
        if (cursor && !stop) {
          (Object.keys(p.sources) as SourceKey[]).forEach((k) => {
            pendingRef.current[k] += p.sources[k] ?? 0;
          });
        }
        cursor = p.now;
      } catch { /* keep cursor; retry next tick */ }
    };
    poll();
    const id = window.setInterval(poll, 3000);
    return () => { stop = true; ctl?.abort(); clearInterval(id); };
  }, []);

  // @ai-agent tasks live from the local store (delegated work)
  const allTasks = useTaskStore((s) => (s._allTasks ?? s.tasks ?? []));
  const agent = useMemo(() => {
    const mine = allTasks.filter((t) => t.assignedTo === '@ai-agent' && !t.deletedAt);
    const has = (t: typeof mine[number], stage: string) => (t.tags ?? []).includes(`ai-stage:${stage}`);
    const inProgress = mine.filter((t) => has(t, 'doing') || has(t, 'queued'));
    const stuck = mine.filter((t) => has(t, 'error'));
    return { inProgress: inProgress.length, stuck, total: mine.length };
  }, [allTasks]);

  useEffect(() => { pausedRef.current = (live?.capturePaused ?? false) || demo === 'paused'; }, [demo, live]);

  // ── particle flow on the scene canvas ──
  useEffect(() => {
    if (tab !== 'dash') return;
    const cv = canvasRef.current;
    const scene = sceneRef.current;
    if (!cv || !scene) return;
    const cx = cv.getContext('2d');
    if (!cx) return;

    let raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      cv.width = cv.offsetWidth * dpr;
      cv.height = cv.offsetHeight * dpr;
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const W = () => cv.offsetWidth;
    const H = () => cv.offsetHeight;
    const core = { x: 0.60, y: 0.46 };
    type P = { sx: number; sy: number; ex: number; ey: number; mx: number; my: number; t: number; sp: number; r: number; warm: boolean };
    const parts: P[] = [];

    const spawn = (s: Src) => {
      const sx = s.x * W() + 42, sy = s.y * H() + 42, ex = core.x * W(), ey = core.y * H();
      const mx = (sx + ex) / 2 + (Math.random() - 0.5) * 90, my = (sy + ey) / 2 + (Math.random() - 0.5) * 90;
      parts.push({ sx, sy, ex, ey, mx, my, t: 0, sp: 0.0016 + Math.random() * 0.001, r: 1.1 + Math.random() * 1.4, warm: Math.random() < 0.1 });
    };
    // Thread is "live" if the source saw any event in the last 10 min.
    const isLive = (s: Src) => s.configured && (ratesRef.current[s.key] ?? 0) > 0;
    const drawThreads = () => {
      SOURCES.forEach((s) => {
        const live = isLive(s);
        const sx = s.x * W() + 42, sy = s.y * H() + 42, ex = core.x * W(), ey = core.y * H();
        const mx = (sx + ex) / 2, my = (sy + ey) / 2 - 30;
        cx.beginPath(); cx.moveTo(sx, sy); cx.quadraticCurveTo(mx, my, ex, ey);
        cx.strokeStyle = live ? 'rgba(55,211,197,.07)' : 'rgba(93,111,109,.05)';
        cx.lineWidth = 1; cx.setLineDash(live ? [] : [2, 7]); cx.stroke(); cx.setLineDash([]);
      });
    };
    // throttle emission so a burst (e.g. 24 audio arrivals at once) spreads
    // over a couple seconds instead of one frame; single arrivals fire at once
    const lastEmit: Record<string, number> = {};
    const MIN_GAP_MS = 130;
    const tick = () => {
      cx.clearRect(0, 0, W(), H());
      drawThreads();
      const paused = pausedRef.current;
      const now = performance.now();
      // drain the pending queue: one particle per real arrival, throttled
      if (!paused) SOURCES.forEach((s) => {
        const pend = pendingRef.current[s.key] ?? 0;
        if (pend <= 0) return;
        if (now - (lastEmit[s.key] ?? 0) < MIN_GAP_MS) return;
        spawn(s);
        pendingRef.current[s.key] = pend - 1;
        lastEmit[s.key] = now;
      });
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; if (!paused) p.t += p.sp;
        if (p.t >= 1) { parts.splice(i, 1); continue; }
        const u = 1 - p.t;
        const x = u * u * p.sx + 2 * u * p.t * p.mx + p.t * p.t * p.ex;
        const y = u * u * p.sy + 2 * u * p.t * p.my + p.t * p.t * p.ey;
        const a = Math.sin(p.t * Math.PI);
        cx.beginPath(); cx.arc(x, y, p.r, 0, 7);
        cx.fillStyle = p.warm ? `rgba(232,161,77,${a * 0.6})` : `rgba(55,211,197,${a * 0.5})`;
        cx.shadowColor = p.warm ? 'rgba(232,161,77,.7)' : 'rgba(55,211,197,.7)';
        cx.shadowBlur = 7; cx.fill(); cx.shadowBlur = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [tab]);

  // ── derive display values: real capture-pause + live, demo overrides preview ──
  const realPaused = live?.capturePaused ?? false;
  const healthOk = live ? live.ok : true;
  // effective state: real pause OR demo wins; otherwise live health drives attention
  const effState: DemoState = (realPaused || demo === 'paused') ? 'paused'
    : demo === 'attention' ? 'attention'
    : (!healthOk || agent.stuck.length > 0 ? 'attention' : '');
  const statusWord = effState === 'paused' ? 'На паузе'
    : effState === 'attention' ? 'Нужно внимание'
    : 'Всё спокойно';
  const heartbeat = relTime(live?.memory?.latestEventAt ?? null);
  const eventsToday = live?.memory?.eventsToday ?? null;
  const skillsVisible = live?.procedural?.visible ?? null;
  const showStuck = effState === 'attention' && (agent.stuck.length > 0 || demo === 'attention');
  const stuckTitle = agent.stuck[0]?.title ?? 'Ревью PR #53';

  // real pause toggle: hits the backend when available, else demo preview
  const togglePause = () => {
    if (isControlCenterAvailable()) {
      const next = !realPaused;
      setLive((p) => (p ? { ...p, capturePaused: next } : p)); // optimistic
      setCapturePaused(next).catch(() => setLive((p) => (p ? { ...p, capturePaused: !next } : p)));
    } else {
      setDemo(demo === 'paused' ? '' : 'paused');
    }
  };

  // per-source live label + dimming
  const srcDisplay = (s: Src) => {
    const a = live?.sources?.[s.key];
    const lastRel = relTime(a?.lastAt ?? null);
    if (!s.configured) return { off: true, label: '—', last: null as string | null };
    const recent = a?.recent ?? 0;
    const label = recent > 20 ? 'активен' : recent > 0 ? 'тихо' : 'нет данных';
    return { off: false, label, last: lastRel };
  };

  const bodyClass = effState ? `cc-${effState}` : '';

  return (
    <div className={`cc-root ${bodyClass}`}>
      <style>{CSS}</style>

      <header className="cc-header">
        <div className="cc-brand">Ассистент</div>
        <nav className="cc-nav">
          <button className={tab === 'dash' ? 'on' : ''} onClick={() => setTab('dash')}>Сейчас</button>
          <button className={tab === 'caps' ? 'on' : ''} onClick={() => setTab('caps')}>Способности</button>
        </nav>
        <div className="cc-spacer" />
        <div className="cc-demo">
          <span className="cc-mono">демо:</span>
          <div className="cc-seg">
            <button className={demo === '' ? 'on' : ''} onClick={() => setDemo('')}>норма</button>
            <button className={demo === 'paused' ? 'on' : ''} onClick={() => setDemo('paused')}>пауза</button>
            <button className={demo === 'attention' ? 'on' : ''} onClick={() => setDemo('attention')}>внимание</button>
          </div>
        </div>
        <button className="cc-pause" onClick={togglePause}>
          <span className="cc-dot" />{effState === 'paused' ? 'На паузе' : 'Наблюдаю'}
        </button>
      </header>

      {tab === 'dash' && (
        <div className="cc-dash">
          <div className="cc-scene" ref={sceneRef} onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.cc-ent') && !(e.target as HTMLElement).closest('.cc-srccard')) setSrcCard(null);
          }}>
            <canvas ref={canvasRef} className="cc-canvas" />
            <div className="cc-hint">Источники питают ассистента живым контекстом. Свечение нити = реальная активность. Клик по сущности — детали.</div>
            {SOURCES.map((s) => (
              <div key={s.name} className={`cc-ent ${srcDisplay(s).off ? 'off' : ''}`} style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}
                   onClick={(e) => { e.stopPropagation(); setSrcCard(s.name); }}>
                <img src={ASSET(s.asset)} alt="" />
                <div className="cc-lbl">{s.shortName}</div>
                <div className="cc-rate">{srcDisplay(s).last ? srcDisplay(s).last : srcDisplay(s).label}</div>
              </div>
            ))}
            <div className="cc-core">
              <img src={ASSET('core-t.png')} alt="" />
              <div className="cc-word">{statusWord}</div>
              <div className="cc-sub">наблюдаю и думаю{heartbeat ? <> · <span className="cc-mono">{heartbeat}</span></> : ''}</div>
              <div className="cc-pnote">Наблюдение на паузе — ничего не записывается.</div>
            </div>
            {srcCard && (() => {
              const cs = SOURCES.find((x) => x.name === srcCard);
              const ca = cs ? live?.sources?.[cs.key] : undefined;
              const last = relTime(ca?.lastAt ?? null);
              return (
              <div className="cc-srccard">
                <h4>{srcCard}</h4>
                <div className="cc-ml">{last ? `последнее наблюдение · ${last}` : 'наблюдений пока нет'}</div>
                <div className="cc-nums">
                  <div><div className="cc-n">{ca?.recent ?? 0}</div><div className="cc-l">за ~10 мин</div></div>
                </div>
                <button className="cc-soon">⏸ Пауза источника <span>скоро</span></button>
              </div>
              );
            })()}
          </div>

          <div className="cc-side">
            <div className="cc-daystrip">
              <div><div className="cc-n">{eventsToday ?? '—'}</div><div className="cc-l">наблюдений</div></div>
              <div><div className="cc-n">{live?.memory?.activeFacts ?? '—'}</div><div className="cc-l">фактов</div></div>
              <div><div className="cc-n">{agent.inProgress}</div><div className="cc-l">в работе</div></div>
              <div><div className="cc-n">{skillsVisible ?? '—'}</div><div className="cc-l">навыков</div></div>
            </div>
            {showStuck && (
              <div className="cc-problem">
                <div className="cc-ttl"><span className="cc-pdot" />Поручение застряло</div>
                <p>«{stuckTitle}» — исполнитель не отвечает. Перезапустить или вернуть тебе?</p>
                <div className="cc-acts"><button>⟳ Перезапустить</button><button>Забрать себе</button><button>Отменить</button></div>
              </div>
            )}
            <div className="cc-feed">
              <h3>Что происходит</h3>
              <Evt t="2 мин" body={<>Предложил задачу <em>«Написать Маше про бюджет Q3»</em></>} sub="заметил договорённость в переписке" />
              <Evt t="18 мин" body="Готовлю предложение по звонку с Андреем" sub="обрабатываю запись разговора" />
              <Evt t="40 мин" body={<>Передал <em>«Ревью PR #53»</em> исполнителю на твоём Маке</>} sub="контекст треда сохранён" />
              <Evt t="1 ч" body="Записал дневную сводку" sub="312 наблюдений за день" />
              <Evt t="3 ч" body={<>Выучил навык <em>«Выставление счёта»</em></>} sub="записан с твоей демонстрации · ждёт проверки" />
            </div>
            {effState === 'paused' && <div className="cc-paused-note">Наблюдение остановлено. Возобновлю по твоей команде.</div>}
          </div>
        </div>
      )}

      {tab === 'caps' && (
        <div className="cc-caps">
          <Group title="Источники" desc="Откуда ассистент получает информацию. Выключенный источник не наблюдается вовсе.">
            <Cap img="source-screen-t.png" h4="Экран" by="наблюдение за окнами" use="741 наблюдение сегодня" foot={<span className="cc-tl">каждые 30 сек</span>} toggle soon />
            <Cap img="source-audio-t.png" h4="Звук" by="микрофон · расшифровка" use="3 ч 12 мин записано" foot={<span className="cc-tl">когда есть речь</span>} toggle soon />
            <Cap img="source-chat-t.png" h4="Slack" by="рабочие пространства" use="204 сообщения сегодня" foot={<span className="cc-tl">3 простр.</span>} toggle soon />
            <Cap img="source-chat-t.png" h4="Telegram" by="личка · группы" use="подключён" foot={<span className="cc-tl">MTProto</span>} toggle soon />
            <Cap img="source-notes-t.png" h4="Заметки" by="Notion" use="выключен · 3 дня назад" off foot={<span className="cc-tl">—</span>} toggle soon />
            <AddCard label="+ Подключить источник" />
          </Group>
          <Group title="Действия" desc="Что ассистент может делать. Доверие: предлагает → делает и сообщает → делает сам.">
            <Cap ico="✍️" h4="Черновики сообщений" by="Telegram · почта" use="12 черновиков · 9 отправлено" foot={<Trust lvl={1} lbl="предлагает" onClick={() => setCeremony(true)} />} toggle soon />
            <Cap ico="⏰" h4="Напоминания" by="сроки · повторы" use="31 за месяц · 0 ошибок" foot={<Trust lvl={2} lbl="делает и сообщает" onClick={() => setCeremony(true)} />} toggle soon />
            <Cap ico="🤝" h4="Передача поручений" by="исполнителям" use="8 поручений · 6 принято" foot={<Trust lvl={1} lbl="предлагает" onClick={() => setCeremony(true)} />} toggle soon />
            <Cap ico="✅" h4="Закрытие задач" by="по наблюдениям" use="17 предложено · 15 верных" foot={<Trust lvl={1} lbl="предлагает" onClick={() => setCeremony(true)} />} toggle soon />
            <AddCard label="+ Добавить действие" />
          </Group>
          <Group title="Навыки" desc="Приёмы, которым ассистент научился: твои правила, его выводы, записанные демонстрации.">
            <Cap ico="📘" h4="Ответы клиентам Upwork" by="✦ выучил сам · подтверждён" use="использован 12 раз · надёжен" foot={<span className="cc-tl">править · архив</span>} toggle />
            <Cap ico="🎬" h4="Выставление счёта" by="● с твоей демонстрации · вчера" use="не использован · ждёт проверки" off foot={<span className="cc-tl">проверить</span>} toggle />
            <Cap ico="✏️" h4="Код-ревью через PR" by="◆ добавил ты" use="использован 26 раз" foot={<span className="cc-tl">править · архив</span>} toggle />
            <AddCard label="+ Новый навык" />
          </Group>
        </div>
      )}

      {ceremony && (
        <div className="cc-ceremony" onClick={() => setCeremony(false)}>
          <div className="cc-cer" onClick={(e) => e.stopPropagation()}>
            <div className="cc-glow" />
            <h3>Повысить доверие?</h3>
            <p>«Напоминания» — 31 раз за месяц, ни одной ошибки.<br />Ассистент готов делать это сам и просто сообщать тебе.</p>
            <div className="cc-lvl"><span>предлагает</span> → <b>делает и сообщает</b></div>
            <div className="cc-soonbadge">управление доверием · скоро</div>
            <div className="cc-ceracts">
              <button className="yes" onClick={() => setCeremony(false)}>Доверяю</button>
              <button className="no" onClick={() => setCeremony(false)}>Пока рано</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Evt({ t, body, sub }: { t: string; body: React.ReactNode; sub: string }) {
  return (
    <div className="cc-evt">
      <div className="cc-t">{t}</div>
      <div><div className="cc-body">{body}</div><div className="cc-evtsub">{sub}</div></div>
    </div>
  );
}

function Group({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="cc-group">
      <h3>{title}</h3>
      <p>{desc}</p>
      <div className="cc-grid">{children}</div>
    </div>
  );
}

function Cap({ img, ico, h4, by, use, foot, off, toggle, soon }:
  { img?: string; ico?: string; h4: string; by: string; use: string; foot: React.ReactNode; off?: boolean; toggle?: boolean; soon?: boolean }) {
  const [on, setOn] = useState(!off);
  return (
    <div className={`cc-cap ${off ? 'off' : ''}`}>
      <div className="cc-caphead">
        {img ? <img src={ASSET(img)} alt="" /> : <div className="cc-ico">{ico}</div>}
        <div><h4>{h4}</h4><div className="cc-by">{by}</div></div>
      </div>
      <div className="cc-use">{use}</div>
      <div className="cc-capfoot">
        {foot}
        {toggle && (
          <button className={`cc-tgl ${on ? 'on' : ''} ${soon ? 'soon' : ''}`} title={soon ? 'Управление скоро' : ''}
                  onClick={() => { if (!soon) setOn(!on); }} />
        )}
      </div>
    </div>
  );
}

function Trust({ lvl, lbl, onClick }: { lvl: number; lbl: string; onClick: () => void }) {
  return (
    <div className="cc-trust" onClick={onClick}>
      {[0, 1, 2].map((i) => <i key={i} className={i < lvl ? 'on' : ''} />)}
      <span className="cc-tl">{lbl}</span>
    </div>
  );
}

function AddCard({ label }: { label: string }) {
  return <button className="cc-add">{label}</button>;
}

const CSS = `
.cc-root{
  --bg:#000302;--ink:#c9d8d6;--ink-dim:#5d6f6d;--ink-faint:#2e3c3a;
  --life:#37d3c5;--life-soft:rgba(55,211,197,.14);--warm:#e8a14d;--warm-soft:rgba(232,161,77,.12);
  --pause:#8fa3c8;--card:rgba(20,32,30,.55);--line:rgba(55,211,197,.08);--r:18px;
  /* full-bleed inside main's p-8 wrapper: cancel the 2rem padding */
  margin:-2rem;width:calc(100% + 4rem);min-height:calc(100vh - 0px);
  position:relative;z-index:1;display:flex;flex-direction:column;
  background:var(--bg);color:var(--ink);
  font-family:ui-sans-serif,system-ui,'Manrope',sans-serif;
  overflow:hidden;
}
.cc-root::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(1300px 900px at 62% 42%,rgba(55,211,197,.05),transparent 60%),
             radial-gradient(900px 700px at 15% 85%,rgba(232,161,77,.028),transparent 55%)}
.cc-mono{font-family:ui-monospace,'JetBrains Mono',monospace}

.cc-header{display:flex;align-items:center;gap:24px;padding:20px 36px;position:relative;z-index:5}
.cc-brand{font-weight:300;font-size:13px;letter-spacing:.32em;color:var(--ink-dim);text-transform:uppercase}
.cc-nav{display:flex;gap:4px;margin-left:10px}
.cc-nav button{background:none;border:none;color:var(--ink-dim);cursor:pointer;font-size:13.5px;font-weight:500;padding:9px 16px;border-radius:99px;transition:all .4s}
.cc-nav button:hover{color:var(--ink)}
.cc-nav button.on{color:var(--bg);background:var(--life);font-weight:600}
.cc-spacer{flex:1}
.cc-demo{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--ink-faint)}
.cc-seg{display:flex;border:1px solid var(--ink-faint);border-radius:99px;overflow:hidden}
.cc-seg button{background:none;border:none;color:var(--ink-dim);font-size:11px;padding:5px 12px;cursor:pointer}
.cc-seg button.on{background:var(--ink-faint);color:var(--ink)}
.cc-pause{display:flex;align-items:center;gap:10px;background:none;border:1px solid rgba(55,211,197,.25);color:var(--life);border-radius:99px;padding:10px 22px;cursor:pointer;font-size:13.5px;font-weight:600;transition:all .5s}
.cc-pause:hover{background:var(--life-soft);border-color:var(--life)}
.cc-pause .cc-dot{width:7px;height:7px;border-radius:50%;background:var(--life);animation:ccbreath 5s ease-in-out infinite}
.cc-paused .cc-pause{border-color:var(--pause);color:var(--pause)}
.cc-paused .cc-pause .cc-dot{background:var(--pause);animation:none}
@keyframes ccbreath{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.78)}}

.cc-dash{display:grid;grid-template-columns:1.25fr .95fr;flex:1;min-height:0;position:relative;z-index:2}
.cc-scene{position:relative;border-right:1px solid var(--line);overflow:hidden}
.cc-canvas{position:absolute;inset:0;width:100%;height:100%;z-index:1}
.cc-hint{position:absolute;left:24px;top:18px;font-size:11px;color:var(--ink-faint);letter-spacing:.04em;z-index:3;max-width:260px;line-height:1.5}
.cc-core{position:absolute;left:60%;top:46%;transform:translate(-50%,-50%);width:300px;height:300px;z-index:3;text-align:center}
.cc-core img{width:100%;height:100%;object-fit:contain;animation:ccbob 9s ease-in-out infinite;filter:drop-shadow(0 0 40px rgba(55,211,197,.25))}
@keyframes ccbob{0%,100%{transform:scale(1);opacity:.96}50%{transform:scale(1.03);opacity:1}}
.cc-paused .cc-core img{animation-play-state:paused;filter:saturate(.2) brightness(.6)}
.cc-core .cc-word{margin-top:6px;font-weight:300;font-size:23px;letter-spacing:.02em}
.cc-attention .cc-core .cc-word{color:var(--warm)}
.cc-core .cc-sub{color:var(--ink-dim);font-size:12.5px;margin-top:8px}
.cc-core .cc-sub .cc-mono{font-size:11.5px}
.cc-core .cc-pnote{display:none;color:var(--pause);font-size:13px;margin-top:6px}
.cc-paused .cc-core .cc-pnote{display:block}
.cc-paused .cc-core .cc-sub{display:none}

.cc-ent{position:absolute;z-index:3;display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;transition:transform .4s}
.cc-ent:hover{transform:scale(1.07)}
.cc-ent img{width:84px;height:84px;object-fit:contain;transition:filter .6s;animation:ccfloat 11s ease-in-out infinite}
.cc-ent:nth-of-type(2) img{animation-delay:-2s}.cc-ent:nth-of-type(3) img{animation-delay:-4s}.cc-ent:nth-of-type(4) img{animation-delay:-7s}.cc-ent:nth-of-type(5) img{animation-delay:-9s}
@keyframes ccfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.cc-ent .cc-lbl{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-dim)}
.cc-ent .cc-rate{font-size:10.5px;color:var(--ink-faint)}
.cc-ent.off img{filter:grayscale(1) brightness(.4) opacity(.5);animation:none}
.cc-paused .cc-ent img{animation-play-state:paused;filter:grayscale(.6) brightness(.6)}
.cc-srccard{position:absolute;left:24px;bottom:24px;width:250px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px;backdrop-filter:blur(18px);z-index:5}
.cc-srccard h4{font-size:14.5px;font-weight:600}
.cc-srccard .cc-ml{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--ink-dim);margin-top:6px}
.cc-srccard .cc-nums{display:flex;gap:20px;margin:16px 0}
.cc-n{font-family:ui-monospace,monospace;font-size:19px;color:var(--life)}
.cc-srccard .cc-l,.cc-daystrip .cc-l{font-size:10px;color:var(--ink-dim);margin-top:2px}

.cc-side{padding:28px 36px 50px;display:flex;flex-direction:column;position:relative;z-index:2;overflow-y:auto}
.cc-daystrip{display:flex;gap:28px;padding-bottom:24px;border-bottom:1px solid var(--line)}
.cc-daystrip>div{text-align:center}
.cc-daystrip .cc-n{font-size:25px}
.cc-paused .cc-daystrip .cc-n,.cc-paused .cc-srccard .cc-n{color:var(--pause)}
.cc-problem{border:1px solid rgba(232,161,77,.35);background:var(--warm-soft);border-radius:var(--r);padding:16px 18px;margin:22px 0 4px}
.cc-problem .cc-ttl{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;color:var(--warm)}
.cc-problem .cc-pdot{width:7px;height:7px;border-radius:50%;background:var(--warm);animation:ccbreath 3s ease-in-out infinite}
.cc-problem p{font-size:13px;color:var(--ink);margin-top:8px;line-height:1.5}
.cc-acts{display:flex;gap:9px;margin-top:12px;flex-wrap:wrap}
.cc-acts button{background:none;border:1px solid rgba(232,161,77,.4);color:var(--warm);border-radius:99px;padding:7px 15px;font-size:12px;cursor:pointer;font-weight:600}
.cc-acts button:hover{background:rgba(232,161,77,.15)}
.cc-feed{margin-top:28px;flex:1}
.cc-feed h3{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;margin-bottom:20px}
.cc-evt{display:flex;gap:16px;padding:13px 0;border-bottom:1px solid rgba(55,211,197,.05)}
.cc-t{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--ink-faint);white-space:nowrap;padding-top:3px;min-width:58px}
.cc-body{font-size:14px;line-height:1.55}
.cc-body em{color:var(--life);font-style:normal}
.cc-evtsub{font-size:11.5px;color:var(--ink-dim);margin-top:3px}
.cc-paused-note{margin-top:20px;color:var(--pause);font-size:13px}

.cc-caps{padding:40px 40px 80px;max-width:1180px;margin:0 auto;position:relative;z-index:2;flex:1;overflow-y:auto;width:100%}
.cc-group{margin-bottom:48px}
.cc-group>h3{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;margin-bottom:8px}
.cc-group>p{font-size:13px;color:var(--ink-dim);margin-bottom:20px}
.cc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:16px}
.cc-cap{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px;transition:all .4s;backdrop-filter:blur(12px)}
.cc-cap:hover{border-color:rgba(55,211,197,.25);transform:translateY(-2px)}
.cc-cap.off{opacity:.55}
.cc-caphead{display:flex;align-items:center;gap:13px;margin-bottom:14px}
.cc-caphead img{width:40px;height:40px;object-fit:contain}
.cc-ico{width:40px;height:40px;border-radius:12px;background:var(--life-soft);display:flex;align-items:center;justify-content:center;font-size:17px}
.cc-caphead h4{font-size:14.5px;font-weight:600}
.cc-by{font-size:10.5px;color:var(--ink-dim);margin-top:2px}
.cc-use{font-family:ui-monospace,monospace;font-size:11px;color:var(--ink-dim);margin-bottom:14px}
.cc-capfoot{display:flex;align-items:center;justify-content:space-between}
.cc-trust{display:flex;gap:4px;align-items:center;cursor:pointer}
.cc-trust i{width:18px;height:5px;border-radius:3px;background:var(--ink-faint);transition:background .4s}
.cc-trust i.on{background:var(--life)}
.cc-trust:hover i:not(.on){background:rgba(55,211,197,.3)}
.cc-tl{font-size:10px;color:var(--ink-dim);margin-left:7px}
.cc-tgl{width:40px;height:22px;border-radius:99px;background:var(--ink-faint);position:relative;cursor:pointer;transition:background .4s;border:none}
.cc-tgl::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:var(--ink);top:3px;left:3px;transition:all .4s}
.cc-tgl.on{background:var(--life)}
.cc-tgl.on::after{left:21px;background:var(--bg)}
.cc-tgl.soon{opacity:.5;cursor:not-allowed}
.cc-add{border:1px dashed var(--ink-faint);border-radius:var(--r);display:flex;align-items:center;justify-content:center;gap:10px;color:var(--ink-dim);font-size:13.5px;cursor:pointer;min-height:130px;transition:all .4s;background:none}
.cc-add:hover{border-color:var(--life);color:var(--life)}
.cc-soon{position:relative}
.cc-soon span{font-size:9px;text-transform:uppercase;letter-spacing:.1em;opacity:.6;margin-left:6px}

.cc-ceremony{position:fixed;inset:0;background:rgba(0,3,2,.82);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:50}
.cc-cer{width:430px;background:#0a1513;border:1px solid rgba(55,211,197,.2);border-radius:24px;padding:38px;text-align:center}
.cc-glow{width:74px;height:74px;border-radius:50%;margin:0 auto 22px;background:radial-gradient(circle,var(--life) 0%,transparent 70%);animation:ccbreath 4s ease-in-out infinite}
.cc-cer h3{font-weight:300;font-size:19px;line-height:1.45;margin-bottom:14px}
.cc-cer p{font-size:13.5px;color:var(--ink-dim);line-height:1.65;margin-bottom:22px}
.cc-lvl{display:flex;justify-content:center;gap:8px;margin-bottom:14px;font-size:12.5px;color:var(--ink-dim);align-items:center}
.cc-lvl b{color:var(--life);font-weight:600}
.cc-soonbadge{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-faint);margin-bottom:24px}
.cc-ceracts{display:flex;gap:12px;justify-content:center}
.cc-ceracts .yes{background:var(--life);color:var(--bg);border:none;border-radius:99px;padding:11px 26px;font-weight:700;font-size:13.5px;cursor:pointer}
.cc-ceracts .no{background:none;border:1px solid var(--ink-faint);color:var(--ink-dim);border-radius:99px;padding:11px 22px;font-size:13.5px;cursor:pointer}
`;
