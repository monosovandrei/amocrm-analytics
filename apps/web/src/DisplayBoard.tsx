import { useEffect, useRef, useState } from 'react';
import { Trophy, Maximize2 } from 'lucide-react';
import { apiUrl } from './lib/api';
import { kpiLabels, kpiNumber, type KpiValue } from './performance-format';
import { workspaceDate, workspaceError } from './workspace-data';

type Board = { metric: keyof typeof kpiLabels; paused: boolean; reason: string | null; rows: Array<KpiValue & { name: string; rank: number | null }> };
export type DisplaySnapshot = { department: string; departmentKey: string; month: string; by: string; definition: string; dataStatus: { cutoffAt: string | null; checkedAt: string | null; status: string }; boards: Board[] };

export default function DisplayBoard({ previewSnapshot }: { previewSnapshot?: DisplaySnapshot }) {
    const [token] = useState(() => {
        const params = new URLSearchParams(window.location.hash.slice(1)), incoming = params.get('display');
        if (incoming) { sessionStorage.setItem('workspace-display-token', incoming); window.history.replaceState(null, '', `${window.location.pathname}#display`); }
        return incoming || sessionStorage.getItem('workspace-display-token') || '';
    });
    const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(previewSnapshot || null), [error, setError] = useState(''), [denied, setDenied] = useState(false), [by, setBy] = useState('completion'), [frame, setFrame] = useState(0), [tick, setTick] = useState(Date.now());
    const lastGood = useRef<Record<string, Board & { cutoffAt: string | null }>>({}), lastReceived = useRef(0), lastMonth = useRef('');
    useEffect(() => {
        if (previewSnapshot) { setSnapshot(previewSnapshot); return; }
        let alive = true, busy = false;
        let controller: AbortController | null = null;
        lastGood.current = {}; setSnapshot(null); setFrame(0);
        const load = async () => {
            if (busy || !token) return;
            busy = true;
            controller = new AbortController();
            const timeout = window.setTimeout(() => controller?.abort(), 12000);
            try {
                const response = await fetch(apiUrl(`/display/snapshot?by=${by}`), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
                if ([401, 403].includes(response.status)) { if (alive) { setDenied(true); setSnapshot(null); lastGood.current = {}; sessionStorage.removeItem('workspace-display-token'); } return; }
                if (!response.ok) throw new Error('Не удалось обновить табло');
                const next = await response.json() as DisplaySnapshot;
                if (alive) {
                    if (lastMonth.current && lastMonth.current !== next.month) lastGood.current = {};
                    lastMonth.current = next.month;
                    next.boards.forEach(board => { if (!board.paused) lastGood.current[board.metric] = { ...board, cutoffAt: next.dataStatus.cutoffAt }; });
                    setSnapshot(next); setError(''); lastReceived.current = Date.now();
                }
            } catch (e) { if (alive) setError(workspaceError(e)); }
            finally { busy = false; clearTimeout(timeout); }
        };
        void load(); const timer = window.setInterval(load, 30000);
        return () => { alive = false; clearInterval(timer); controller?.abort(); };
    }, [token, by, previewSnapshot]);
    useEffect(() => { const timer = window.setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, []);
    useEffect(() => { const timer = window.setInterval(() => setFrame(f => f + 1), 20000); return () => clearInterval(timer); }, []);
    if (!previewSnapshot && (denied || !token)) return <main className="tv-board"><h1>Доступ к табло {denied ? 'истёк или отозван' : 'не настроен'}</h1><p>Администратор может создать новую ссылку в разделе «Табло».</p></main>;
    const frames = snapshot?.boards.flatMap(board => Array.from({ length: Math.max(1, Math.ceil(board.rows.length / 5)) }, (_, page) => ({ board, page }))) || [];
    const selected = frames[frame % (frames.length || 1)];
    const board = selected?.board;
    const stale = Boolean(error) || tick - lastReceived.current > 50000 || !snapshot?.dataStatus.cutoffAt || tick - +new Date(snapshot.dataStatus.cutoffAt) > 180000;
    const paused = stale || board?.paused;
    const visible = previewSnapshot ? board : board && paused ? lastGood.current[board.metric] : board;
    const rows = visible?.rows.slice((selected?.page || 0) * 5, ((selected?.page || 0) + 1) * 5) || [];
    const label = board?.metric === 'proposals' ? snapshot?.departmentKey === 'csm' ? 'КП сделано' : 'КП презентовано' : board ? kpiLabels[board.metric] : 'Табло отдела';
    const monthDate = snapshot?.month ? new Date(`${snapshot.month}-01T12:00:00Z`) : null;
    const monthLabel = monthDate && !Number.isNaN(+monthDate) ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).format(monthDate) : 'Текущий месяц';
    const maximumFact = Math.max(0, ...visible?.rows.map(row => row.fact) || []);
    const completionBars = !previewSnapshot && by === 'completion';
    const Surface = previewSnapshot ? 'section' : 'main';
    return <Surface className="tv-board" aria-label={previewSnapshot ? 'Предпросмотр табло' : 'Табло отдела'}>
        <header className="tv-header">
            <div><p>{snapshot?.department || 'Отдел'} <span> / {monthLabel}</span></p><h1>{label}</h1></div>
            {!previewSnapshot && <label><span>Соревнование</span><select value={by} onChange={e => { setBy(e.target.value); setFrame(0); }}><option value="completion">По выполнению цели</option><option value="fact">По факту</option></select></label>}
        </header>
        {snapshot && <nav className="tv-metrics" aria-label="Показатель соревнования">{snapshot.boards.map(item => <button key={item.metric} aria-current={item.metric === board?.metric ? 'page' : undefined} onClick={() => setFrame(frames.findIndex(entry => entry.board.metric === item.metric))}>{item.metric === 'proposals' ? snapshot.departmentKey === 'csm' ? 'КП сделано' : 'КП презентовано' : kpiLabels[item.metric]}</button>)}</nav>}
        <div className="tv-race">
        <p className={!previewSnapshot && paused ? 'tv-status tv-paused' : 'tv-status'} role="status">{previewSnapshot ? 'Предпросмотр · места скрыты до проверки данных и целей' : !snapshot ? error || 'Загрузка…' : paused ? `Рейтинг приостановлен: ${error ? 'нет связи' : board?.reason || 'данные не обновлены'}. ${visible ? 'Последний подтверждённый результат.' : 'Подтверждённого результата нет.'}` : by === 'fact' ? 'Рейтинг по факту · длина полос — относительно лучшего результата' : 'Рейтинг по выполнению цели · полоса заполняется до 100%'}</p>
        {snapshot && rows.length > 0 && <table className="tv-table"><thead><tr><th>Место</th><th>Менеджер</th><th>Результат</th><th>{completionBars ? 'Выполнение цели' : 'Сравнение факта'}</th></tr></thead><tbody key={`${board?.metric}:${selected?.page}`}>{rows.map((row, index) => {
            const rank = previewSnapshot ? null : row.rank;
            const progress = completionBars ? row.completion : maximumFact > 0 ? row.fact / maximumFact * 100 : 0;
            return <tr key={`${row.name}:${index}`} className={rank != null && rank <= 3 ? `tv-place-${rank}` : undefined}>
                <td><span className="tv-rank">{rank === 1 ? <><Trophy aria-hidden="true"/><span className="sr-only">Место </span>1</> : rank ?? '—'}</span></td>
                <th scope="row">{row.name}</th>
                <td className="tv-result"><strong>{kpiNumber(row.fact, board!.metric)}</strong><span>{row.plan == null ? 'Цель не задана' : `Цель ${kpiNumber(row.plan, board!.metric)}`}</span></td>
                <td className="tv-progress-cell"><div className="tv-progress-label">{row.completion == null ? 'Без цели' : <><strong>{row.completion.toFixed(0)}%</strong><span>{row.completion >= 100 ? 'Цель достигнута' : 'от цели'}</span></>}</div><div className="tv-progress-track" role={progress == null ? undefined : 'meter'} aria-label={completionBars ? `Выполнение цели: ${row.name}` : `Факт относительно лучшего результата: ${row.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress == null ? undefined : Math.max(0, Math.min(100, progress))} aria-valuetext={completionBars ? row.completion == null ? 'Цель не задана' : `${row.completion.toFixed(0)}%` : kpiNumber(row.fact, board!.metric)}>{progress != null && <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}/>}</div></td>
            </tr>;
        })}</tbody></table>}
        {snapshot && !rows.length && <p className="tv-empty">{paused ? 'Ожидаем подтверждения данных и правил' : 'Нет участников на этой странице'}</p>}
        </div>
        <footer className="tv-footer">
            <span>Данные: {workspaceDate(!previewSnapshot && paused && board ? lastGood.current[board.metric]?.cutoffAt || null : snapshot?.dataStatus.cutoffAt || null)}<br/>{snapshot?.definition}</span>
            <span>{selected ? `${(selected.page + 1)} / ${Math.max(1, Math.ceil(selected.board.rows.length / 5))}` : ''} · Смена экрана каждые 20 с</span>
            <button onClick={event => {
                const target = previewSnapshot ? event.currentTarget.closest('.tv-board') as HTMLElement : document.documentElement;
                void (document.fullscreenElement ? document.exitFullscreen() : target?.requestFullscreen?.())?.catch(() => setError('Браузер не разрешил полноэкранный режим'));
            }}><Maximize2 size={20} aria-hidden="true"/>На весь экран</button>
        </footer>
    </Surface>;
}
