import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { copyWorkspaceLink, useWorkspaceResource, workspaceDate, workspaceError } from './workspace-data';
import DisplayBoard, { type DisplaySnapshot } from './DisplayBoard';
import { kpiLabels, kpiNumber, type KpiValue } from './performance-format';

type KpiRow = { id: string; name: string; values: KpiValue[]; participant: boolean; currentMember?: boolean; canSetGoal?: boolean };
type Performance = { canEdit: boolean; period: string; start: string; month: string; department: string; rows: KpiRow[]; total: KpiRow | null; policy: { mode: string } | null; definition: string; shipmentDefinition: string; periodNote: string; incompleteShipments: boolean; unattributedMetrics?: string[]; unresolvedShipments?: number; unknownEvents?: number; dataStatus: { status: string; cutoffAt: string | null; checkedAt: string | null } };

export default function PerformanceWorkspace({ query, department, month, personal, amoDomain, navigate }: { query: string; department: string; month: string; personal: boolean; amoDomain: string; navigate: (tab: string, kind?: string) => void }) {
    const [period, setPeriod] = useState('MONTH'), [day, setDay] = useState(''), [editing, setEditing] = useState(false), [rules, setRules] = useState(false), [proof, setProof] = useState(false), [comparison, setComparison] = useState(false);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const anchor = day.startsWith(month) ? day : month === today.slice(0, 7) ? today : `${month}-01`;
    const resource = useWorkspaceResource<Performance>(`/workspaces/performance?${query}&${new URLSearchParams({ period, day: anchor })}`);
    const { data, error, loading } = resource;
    const planRows = data?.rows.filter(row => data.policy ? row.participant : row.currentMember) || [];
    const label = (metric: keyof typeof kpiLabels) => metric === 'proposals' ? department === 'csm' ? 'КП сделано' : 'КП презентовано' : kpiLabels[metric];
    const goalEditor = (row: KpiRow, value: KpiValue) => editing && !personal && row.canSetGoal !== false && (row.id === data?.total?.id || planRows.some(r=>r.id===row.id)) && <GoalEditor row={row} value={value} department={department} month={month} period={period} day={anchor} targetType={row.id === data?.total?.id ? 'GROUP' : 'MANAGER'} onSaved={(goal, version) => resource.setData(old => {
        if (!old) return old;
        const patch = (r: KpiRow) => r.id !== row.id ? r : { ...r, values: r.values.map(v => v.metric !== value.metric ? v : { ...v, plan: goal, version, completion: goal > 0 ? v.fact / goal * 100 : null, remaining: Math.max(0, goal - v.fact) }) };
        return { ...old, rows: old.rows.map(patch), total: old.total ? patch(old.total) : null };
    })}/>;
    return <section className="performance-workspace">
        <h1 className="page-title">{personal ? 'Мои результаты и задачи' : 'Результаты и риски отдела'}</h1>
        <div className="workspace-toolbar"><label><span className="label">Период показателей</span><select className="field" value={period} onChange={e => setPeriod(e.target.value)}><option value="DAY">День</option><option value="WEEK">Неделя</option><option value="MONTH">Месяц</option></select></label>
            {period !== 'MONTH' && <label><span className="label">{period === 'WEEK' ? 'Неделя с выбранной датой' : 'Дата'}</span><input className="field" type="date" value={anchor} min={`${month}-01`} max={`${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`} onChange={e => setDay(e.target.value)}/></label>}
            {!personal && <><button className="btn" aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'Завершить настройку целей' : 'Настроить цели'}</button><button className="btn" aria-expanded={rules} onClick={() => setRules(!rules)}>Правила и участники</button></>}
        </div>
        {error && <p role="alert" className="workspace-warning">{error} {data ? 'Последний результат оставлен на экране; не используйте его как свежий.' : ''}<button className="btn" onClick={resource.reload}>Повторить</button></p>}
        {loading && <p aria-live="polite">Загрузка результатов…</p>}
        {data && <>
            <details className={data.dataStatus.status === 'CERTIFIED' && !error ? 'workspace-source' : 'workspace-warning'}><summary><span role="status">{error ? 'Обновление приостановлено' : data.dataStatus.status === 'CERTIFIED' ? 'Сверка источника пройдена' : 'Данные не подтверждены — рейтинг приостановлен'}</span></summary><p>Данные: {workspaceDate(data.dataStatus.cutoffAt)}. Проверка: {workspaceDate(data.dataStatus.checkedAt)}.</p></details>
            {!personal && data.total && <p className="text-sm muted">Отдел целиком, включая исторические действия и подтверждённые отгрузки прежних сотрудников. В соревновании — только утверждённый состав.</p>}
            {(data.total ? [data.total] : data.rows).map(row => <section className="personal-kpis" key={row.id} aria-label="Четыре показателя">{row.values.map(value => <article key={value.metric} className="personal-kpi"><h2>{label(value.metric)}</h2><strong>{kpiNumber(value.fact, value.metric)}</strong><dl><div><dt>Цель</dt><dd>{kpiNumber(value.plan, value.metric)}</dd></div><div><dt>Выполнение</dt><dd>{value.completion == null ? 'Не рассчитывается' : `${value.completion.toFixed(1)}%`}</dd></div><div><dt>Осталось</dt><dd>{kpiNumber(value.remaining, value.metric)}</dd></div></dl>{value.fact !== value.raw && <p className="text-sm">В amoCRM {value.raw} переходов; повторные не дают зачёт.</p>}{goalEditor(row, value)}</article>)}</section>)}
            {!personal && <button className="btn" disabled={editing} aria-expanded={comparison || editing} onClick={() => setComparison(!comparison)}>{comparison || editing ? 'Скрыть сравнение менеджеров' : 'Сравнить менеджеров'}</button>}
            {!personal && (comparison || editing) && <div className="overflow-x-auto"><table className="data-table performance-table"><caption>Личные результаты: факт / цель / выполнение</caption><thead><tr><th>Сотрудник</th>{Object.keys(kpiLabels).map(key => <th key={key}>{label(key as keyof typeof kpiLabels)}</th>)}</tr></thead><tbody>{data.rows.map(row => <tr key={row.id}><th scope="row">{row.name}{data.policy && !row.participant && <div className="text-sm muted">Вне состава соревнования</div>}</th>{row.values.map(value => <td key={value.metric}><div className="kpi-fact">{kpiNumber(value.fact, value.metric)}</div><div className="text-sm muted">{value.plan == null ? 'Цель не задана' : `${kpiNumber(value.plan, value.metric)} · ${value.completion == null ? 'без процента' : `${value.completion.toFixed(1)}%`}`}</div>{value.fact !== value.raw && <div className="text-sm">{value.raw} переходов amoCRM</div>}{goalEditor(row, value)}</td>)}</tr>)}</tbody></table></div>}
            {editing && data.total && <p className="text-sm">Цель отдела задаётся отдельно. Сверка с личными целями участников: {data.total.values.map(v => { const sum = planRows.reduce((s, r) => s + (r.values.find(m => m.metric === v.metric)?.plan || 0), 0), missing = planRows.filter(r => r.values.find(m => m.metric === v.metric)?.plan == null).length; return `${label(v.metric)}: личные цели ${kpiNumber(sum, v.metric)}, отдел ${kpiNumber(v.plan, v.metric)}, без цели ${missing}`; }).join('; ')}.</p>}
            {data.incompleteShipments && <p className="workspace-warning" role="status">Отгрузки учтены не полностью: есть сборки без подтверждённого продавца. Рейтинг отгрузок приостановлен.{data.unresolvedShipments != null ? ` Требуют разбора: ${data.unresolvedShipments}.` : ''}</p>}
            {Boolean(data.unattributedMetrics?.length) && <p className="workspace-warning" role="status">Есть действия без подтверждённого исполнителя. Рейтинг соответствующих показателей приостановлен; действия не назначаются менеджерам по догадке.</p>}
            {!personal && <p className="text-sm muted">Исходные переходы amoCRM включают автоматизацию и нераспределённые действия; они не дают личный зачёт менеджеру.</p>}
            {!data.policy && <p role="status" className="text-sm">Соревнование ещё не запущено. Показаны действия amoCRM.</p>}
            <details className="workspace-definition"><summary>Правила расчёта показателей</summary><p>{data.definition} {data.periodNote}</p><p>Оплата — действие перевода в оплаченный этап amoCRM, не подтверждение движения денег в банке. {data.shipmentDefinition} Денежные планы по оплатам доступны отдельно в «План-факт».</p>{!personal && Boolean(data.unknownEvents) && <p>Действий автоматизации или исполнителей вне текущего отдела: {data.unknownEvents}. Они не распределяются между менеджерами по догадке.</p>}</details>
            <button className="btn" aria-expanded={proof} onClick={() => setProof(!proof)}>{proof ? 'Скрыть проверку зачёта' : 'Проверить зачёт по сделкам'}</button>
            {proof && <KpiProof query={`${query}&${new URLSearchParams({ period, day: anchor })}`} amoDomain={amoDomain}/>}
        </>}
        {rules && !personal && <CompetitionSettings key={`${department}:${month}`} department={department} month={month} onSaved={resource.reload}/>}
        <div className="workspace-actions"><button className="btn" onClick={() => navigate(personal ? 'plan' : 'reports')}>{personal ? 'Проверить факт оплат' : 'Открыть отчёты amoCRM'}</button><button className="btn" onClick={() => navigate('forecast')}>Проверить прогноз</button></div>
        <section className="workspace-queues" aria-label="Требуют внимания"><WorkQueue query={query} kind="sales" amoDomain={amoDomain} navigate={navigate}/><WorkQueue query={query} kind="shipments" amoDomain={amoDomain} navigate={navigate}/></section>
    </section>;
}

function KpiProof({ query, amoDomain }: { query: string; amoDomain: string }) {
    const [metric, setMetric] = useState('proposals'), [page, setPage] = useState(1);
    useEffect(() => setPage(1), [query, metric]);
    const { data, error, loading } = useWorkspaceResource<any>(`/workspaces/performance?${query}&detail=${metric}&page=${page}`);
    return <section className="workspace-settings"><h2>Проверка зачёта</h2><label><span className="label">Показатель</span><select className="field" value={metric} onChange={e => setMetric(e.target.value)}>{Object.entries(kpiLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>{error && <p role="alert">{error}</p>}{loading ? <p>Загрузка действий…</p> : data?.proof && <><p>Действий в выбранном периоде: {data.proof.total}. В списке также показаны повторные переходы без зачёта. Переданная чужому менеджеру сделка может быть скрыта, но её зачёт сохраняется.</p><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Сделка</th><th>Дата действия</th><th>Зачёт</th><th>Основание</th><th>Событие amoCRM</th></tr></thead><tbody>{data.proof.rows.map((r: any, i: number) => <tr key={r.eventId || i}><td>{r.externalId ? <a href={`https://${amoDomain}.amocrm.ru/leads/detail/${r.externalId}`} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</td><td>{workspaceDate(r.occurredAt)}</td><td>{r.counted ? 'Да' : 'Нет'}</td><td>{r.reason}</td><td>{r.eventId || 'Переход сборки в отгрузку'}</td></tr>)}</tbody></table></div>{!data.proof.rows.length && <p>Действий по этому показателю нет.</p>}<div className="workspace-toolbar"><button className="btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Назад</button><span>Страница {page}</span><button className="btn" disabled={page * 50 >= data.proof.total} onClick={() => setPage(p => p + 1)}>Далее</button></div></>}</section>;
}

function GoalEditor({ row, value, department, month, period, day, targetType, onSaved }: { row: KpiRow; value: KpiValue; department: string; month: string; period: string; day: string; targetType: string; onSaved: (value: number, version: number) => void }) {
    const [draft, setDraft] = useState<string | null>(null), [baseVersion, setBaseVersion] = useState(value.version), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    useEffect(() => { setDraft(null); setNotice(''); }, [department, month, period, day]);
    async function save() { setBusy(true); setNotice(''); try { const result = await api<{ version: number }>('/workspaces/performance/goals', { method: 'PATCH', body: JSON.stringify({ department, month, period, day, targetType, targetId: row.id, metric: value.metric, value: draft, version: baseVersion }) }); onSaved(Number(draft), result.version); setDraft(null); setNotice('Сохранено'); } catch (e) { setNotice(workspaceError(e)); } finally { setBusy(false); } }
    return <form className="goal-editor" onSubmit={e => { e.preventDefault(); void save(); }}><label className="sr-only" htmlFor={`goal-${row.id}-${value.metric}`}>Цель {row.name}: {kpiLabels[value.metric]}</label><input id={`goal-${row.id}-${value.metric}`} className="field" type="number" min="0" step={value.metric === 'shipments' ? '0.01' : '1'} value={draft ?? value.plan ?? ''} onChange={e => { if (draft == null) setBaseVersion(value.version); setDraft(e.target.value); }}/><button className="btn" disabled={busy || draft == null || draft === ''}>{busy ? 'Сохранение…' : 'Сохранить'}</button>{notice && <span role="status">{notice}</span>}</form>;
}

function WorkQueue({ query, kind, amoDomain, navigate }: { query: string; kind: string; amoDomain: string; navigate: (tab: string, kind?: string) => void }) {
    const { data, error, loading } = useWorkspaceResource<any>(`/workspaces/deals?${query}&kind=${kind}&attention=true&sort=amount`);
    return <section className="workspace-queue"><h2>{kind === 'sales' ? 'Продажи: требуют внимания' : 'Отгрузки: требуют внимания'}</h2>{error && <p role="alert">{error}</p>}{loading ? <p>Проверка сделок…</p> : data && <><p>{data.total ? `${data.total} сделок · ${kpiNumber(data.amount, 'shipments')}. Первыми — наибольшие суммы.` : 'Сделок по условиям контроля нет.'}</p><ul>{data.rows.slice(0, 3).map((r: any) => <li key={r.id}><a target="_blank" rel="noreferrer" href={`https://${amoDomain}.amocrm.ru/leads/detail/${r.externalId}`}>{r.title}</a><span>{r.commercialManager} · {r.stage} · {kpiNumber(r.amount, 'shipments')}</span><span>{r.reason}</span></li>)}</ul></>}<button className="btn" onClick={() => navigate('deals', kind)}>Открыть список</button></section>;
}

function CompetitionSettings({ department, month, onSaved }: { department: string; month: string; onSaved: () => void }) {
    const { data, error, loading, reload } = useWorkspaceResource<any>(`/workspaces/competition?${new URLSearchParams({ department, month })}`);
    const [mode, setMode] = useState('UNIQUE_DEAL'), [members, setMembers] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    async function save() { setBusy(true); try { await api('/workspaces/competition', { method: 'POST', body: JSON.stringify({ department, month, mode, memberIds: members, confirmed }) }); setNotice('Правила утверждены'); reload(); onSaved(); } catch (e) { setNotice(workspaceError(e)); } finally { setBusy(false); } }
    return <section className="workspace-settings">
        <h2>Правила соревнования на {month}</h2>
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        {loading ? <p>Загрузка…</p> : data?.policy ? <p>
            Утверждены {workspaceDate(data.policy.createdAt)}. {data.policy.mode === 'UNIQUE_DEAL' ? 'Один зачёт на сделку и показатель, первому исполнителю по загруженной истории amoCRM; повтор в другом месяце тоже не засчитывается.' : 'Каждый переход этапа amoCRM.'}
            {' '}Участники: {data.candidates.filter((c: any) => data.policy.memberIds.includes(c.id)).map((c: any) => c.name).join(', ') || 'Список изменился в CRM'}.
            {' '}Правила и состав этого месяца зафиксированы.
        </p> : data && <>
            <label><span className="label">Зачёт КП, счетов и оплат</span><select className="field" value={mode} onChange={e => setMode(e.target.value)}>
                <option value="UNIQUE_DEAL">Одна сделка — один зачёт на показатель</option><option value="AMO_EVENTS">Каждый переход, как в amoCRM</option>
            </select></label>
            <p>{mode === 'UNIQUE_DEAL' ? 'Повторные входы по той же сделке не дают нового зачёта даже в другом месяце.' : 'Повторные переходы засчитываются, как в исходном отчёте amoCRM.'} Сборка считается один раз за период; отгрузка относится к подтверждённому продавцу. Прогноз не участвует в соревновании. Правила и состав фиксируются до конца месяца; цели меняются с записью в журнале.</p>
            <fieldset><legend>Участники — исключите технические аккаунты</legend><div className="competition-members">{data.candidates.map((c: any) => <label key={c.id}><input type="checkbox" checked={members.includes(c.id)} onChange={e => setMembers(old => e.target.checked ? [...old, c.id] : old.filter(id => id !== c.id))}/>{c.name}</label>)}</div></fieldset>
            <label className="workspace-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>Правила и состав согласованы с отделом</label>
            <button className="btn" disabled={busy || !confirmed || !members.length} onClick={() => void save()}>{busy ? 'Сохранение…' : 'Утвердить правила и состав'}</button>
        </>}
    </section>;
}

export function DisplaySettings({ departments }: { departments: Array<{ key: string; name: string }> }) {
    const { data, error, reload } = useWorkspaceResource<any[]>('/workspaces/displays');
    const [department, setDepartment] = useState(departments[0]?.key || ''), [name, setName] = useState('Телевизор отдела'), [hours, setHours] = useState('24'), [link, setLink] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState(false);
    const previewData = useWorkspaceResource<DisplaySnapshot>(preview ? `/workspaces/displays/preview?department=${encodeURIComponent(department)}` : null);
    async function create() { setBusy(true); setLink(''); try { const result = await api<{ token: string }>('/workspaces/displays', { method: 'POST', body: JSON.stringify({ department, name, hours: Number(hours) }) }); const url = new URL(window.location.href); url.search = ''; url.hash = `display=${result.token}`; setLink(url.toString()); reload(); } catch (e) { setNotice(workspaceError(e)); } finally { setBusy(false); } }
    async function revoke(id: string) { setBusy(true); try { await api(`/workspaces/displays/${id}/revoke`, { method: 'PATCH' }); reload(); setLink(''); setNotice('Доступ экрана отозван'); } catch (e) { setNotice(workspaceError(e)); } finally { setBusy(false); } }
    return <section><h1 className="page-title">Телевизионное табло</h1>
        <p>Отдельный доступ только к четырём показателям отдела. Без клиентов, контактов и настроек. Ссылку сохраняйте как пароль; она показывается один раз.</p>
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        <div className="workspace-toolbar">
            <label><span className="label">Название экрана</span><input className="field" value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
            <label><span className="label">Отдел</span><select className="field" value={department} onChange={e => setDepartment(e.target.value)}>{departments.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}</select></label>
            <label><span className="label">Срок доступа</span><select className="field" value={hours} onChange={e => setHours(e.target.value)}><option value="8">8 часов</option><option value="24">24 часа</option><option value="168">7 дней</option></select></label>
            <button className="btn" disabled={busy || !name.trim()} onClick={() => void create()}>Создать доступ к табло</button>
        </div>
        {link && <p><a href={link} target="_blank" rel="noreferrer">Открыть табло</a> · <button className="btn" onClick={() => void copyWorkspaceLink(link).then(() => setNotice('Ссылка скопирована'), () => setNotice('Браузер не разрешил копирование. Скопируйте адрес через контекстное меню ссылки.'))}>Скопировать ссылку</button></p>}
        <div className="workspace-toolbar"><button className="btn" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? 'Закрыть предпросмотр' : 'Предпросмотр табло без выдачи доступа'}</button></div>
        {preview && <>{previewData.error && <p role="alert">{previewData.error}</p>}{previewData.loading ? <p>Загрузка предпросмотра…</p> : previewData.data && <div className="tv-preview"><DisplayBoard previewSnapshot={previewData.data}/></div>}</>}
        <ul className="display-access-list">{data?.map(d => <li key={d.id}><span>{d.name} · {departments.find(x => x.key === d.departmentKey)?.name} · до {workspaceDate(d.expiresAt)}{d.revokedAt ? ' · отозван' : ''}</span><button className="btn" disabled={busy || Boolean(d.revokedAt)} onClick={() => void revoke(d.id)}>Отозвать доступ</button></li>)}</ul></section>;
}
