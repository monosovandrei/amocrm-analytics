import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { api, downloadFile } from './lib/api';
import FieldCombobox from './FieldCombobox';
type Session = {
    configured: boolean;
    message?: string;
    name: string;
    role: 'ADMIN' | 'ROP' | 'MANAGER';
    departmentKey: string | null;
    fingerprint: string;
    amoDomain: string;
    cutoffAt: string | null;
    checkedAt: string | null;
    fresh: boolean;
    departments: Array<{
        key: string;
        name: string;
        groupId: string;
    }>;
    managers: Array<{
        id: string;
        name: string;
        groupId: string;
    }>;
    reports: Record<string, string[]>;
};
type ReportRenderer = (result: Record<string, any>, key: string, amoDomain: string) => ReactNode;
const labels: Record<string, string> = { sales_funnel_steps: 'Продажи: шаги и конверсии', sales_weighted_funnel: 'Продажи: взвешенная воронка',
    sales_assigned_stage_speed: 'Продажи: скорость обработки', sales_stage_age: 'Продажи: текущие сделки по этапам', sales_loss_reasons: 'Продажи: причины отказа',
    csm_funnel: 'CS: воронка', csm_weighted_funnel: 'CS: взвешенная воронка', csm_base_stage_age: 'CS: текущие сделки в базе', csm_assigned_stage_age: 'CS: текущие закреплённые сделки' };
const money = (value: number | null | undefined) => value == null ? 'Нет данных' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
const errorText = (error: unknown) => { const raw = error instanceof Error ? error.message : String(error); try {
    return JSON.parse(raw).message || raw;
}
catch {
    return /Failed to fetch|NetworkError|Load failed/i.test(raw)?'Нет соединения с платформой. Последние данные не считаются обновлёнными.':raw;
} };
const date = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК' : 'Нет данных';
export default function RoleWorkspace({ onLogout, renderReport, renderTelegram }: {
    onLogout: () => void;
    renderReport: ReportRenderer;
    renderTelegram: () => ReactNode;
}) {
    const [session, setSession] = useState<Session | null>(null), [error, setError] = useState(''), [tab, setTab] = useState('');
    const [department, setDepartment] = useState(''), [manager, setManager] = useState(''), [month, setMonth] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date()));
    const fingerprint = useRef('');
    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const s = await api<Session>('/workspaces/session');
                if (!alive)
                    return;
                if (fingerprint.current && fingerprint.current !== s.fingerprint) {
                    setManager('');
                    setDepartment(s.departmentKey || s.departments?.[0]?.key || '');
                    setTab(s.role === 'MANAGER' ? 'plan' : 'reports');
                }
                fingerprint.current = s.fingerprint;
                setSession(s);
                setDepartment(d => d || s.departmentKey || s.departments?.[0]?.key || '');
                setTab(t => t || (s.role === 'MANAGER' ? 'plan' : 'reports'));
                setError('');
            }
            catch (e) {
                if (alive) {
                    setSession(null);
                    setError(errorText(e));
                }
            }
        };
        void load();
        const timer = window.setInterval(load, 20000);
        return () => { alive = false; clearInterval(timer); };
    }, []);
    if (error)
        return <main className="content"><p role="alert">{error}</p><button className="btn" onClick={onLogout}>Выйти</button></main>;
    if (!session)
        return <main className="content" aria-live="polite">Загрузка кабинета…</main>;
    if (!session.configured)
        return <main className="content"><h1>Доступ не настроен</h1><p>{session.message || 'Обратитесь к администратору'}</p><button className="btn" onClick={onLogout}>Выйти</button></main>;
    const personal = session.role === 'MANAGER';
    const nav = [...(!personal ? [['reports', 'Отчёты']] : []), ['plan', personal ? 'Мой план' : 'План-факт'], ['forecast', personal ? 'Мой прогноз' : 'Прогноз'], ['deals', personal ? 'Мои сделки' : 'Сделки отдела'], ...(session.role === 'ADMIN' ? [['admin', 'Настройки'], ['telegram', 'Telegram']] : [])];
    const forecastMonth=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date());
    const query = new URLSearchParams({ department, month:tab==='forecast'?forecastMonth:month, ...(manager ? { manager } : {}) }).toString();
    return <main className="app-shell"><section className="app-main"><header className="topbar"><div className="topbar-main">
    <div className="topbar-brand"><div><strong>amoCRM Analytics</strong><div className="text-sm muted">{personal ? 'Кабинет менеджера' : session.role === 'ADMIN' ? 'Администрирование' : 'Кабинет РОПа'}</div></div></div>
    <nav className="topbar-nav" aria-label="Разделы кабинета">{nav.map(([id, label]) => <button key={id} className={`topbar-nav-item ${tab === id ? 'active' : ''}`} onClick={() => {if(department==='all'&&id!=='forecast')setDepartment(session.departments[0].key);setTab(id);}}>{label}</button>)}</nav>
    <div className="flex items-center gap-3"><span>{session.name}</span><button className="icon-btn" aria-label="Выйти" onClick={onLogout}><LogOut size={18}/></button></div>
  </div></header><section className="content" key={session.fingerprint}><div className="content-inner">
    {['admin','deals','telegram'].includes(tab)&&<p role="status" className="text-sm">{session.fresh ? 'Синхронизация актуальна' : 'Данные требуют проверки'} · Данные: {date(session.cutoffAt)} · Проверка: {date(session.checkedAt)}</p>}
    {!['admin', 'telegram'].includes(tab) && <div className="flex flex-wrap items-end gap-3 mb-4">
      <label><span className="label">{tab==='forecast'?'Текущий месяц прогноза':'Месяц'}</span><input className="field" type="month" disabled={tab==='forecast'} value={tab==='forecast'?forecastMonth:month} onChange={e => setMonth(e.target.value)}/></label>
      {session.role === 'ADMIN' && <label><span className="label">Отдел</span><select className="field" value={department} onChange={e => { setDepartment(e.target.value); setManager(''); }}>{session.departments.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}{tab==='forecast'&&<option value="all">Все отделы и нераспределённые отгрузки</option>}</select></label>}
      {!personal && department!=='all' && <FieldCombobox label="Сотрудник" value={manager} onChange={setManager} options={[{value:'',label:'Весь отдел'},...session.managers.filter(m=>m.groupId===session.departments.find(d=>d.key===department)?.groupId).map(m=>({value:m.id,label:m.name}))]} placeholder="Выберите сотрудника" />}
    </div>}
    {tab === 'plan' && <PlanTable key={session.fingerprint} query={query} department={department} month={month} amoDomain={session.amoDomain} renderReport={renderReport}/>}
    {tab === 'reports' && <ReportPanel key={department} query={query} keys={session.reports[department] || []} amoDomain={session.amoDomain} renderReport={renderReport}/>}
    {tab === 'forecast' && <ReportPanel query={query} keys={department==='all'?['revenue_profit_forecast']:['revenue_profit_forecast', department === 'sales' ? 'sales_weighted_funnel' : 'csm_weighted_funnel']} amoDomain={session.amoDomain} renderReport={renderReport}/>}
    {tab === 'deals' && <Deals query={query} amoDomain={session.amoDomain}/>}
    {tab === 'admin' && <AdminSettings amoDomain={session.amoDomain}/>}
    {tab === 'telegram' && session.role === 'ADMIN' && renderTelegram()}
  </div></section></section></main>;
}
function useResource<T>(path: string | null) {
    const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
    useEffect(() => { let alive = true, busy = false; setData(null); setError(''); setLoading(Boolean(path)); if(!path)return; const load = async () => { if (busy)
        return; busy = true; try {
        const result = await api<T>(path);
        if (alive) {
            setData(result);
            setError('');
        }
    }
    catch (e) {
        if (alive)
            setError(errorText(e));
    }
    finally {
        busy = false;
        if (alive)
            setLoading(false);
    } }; void load(); const timer = window.setInterval(load, 20000); return () => { alive = false; clearInterval(timer); }; }, [path]);
    return { data, error, loading, setData };
}
function PlanTable({ query, department, month, amoDomain, renderReport }: {
    query: string;
    department: string;
    month: string;
    amoDomain:string;
    renderReport:ReportRenderer;
}) {
    const { data, error, loading, setData } = useResource<any>(`/workspaces/plans?${query}`);
    const forecast=useResource<any>(data?`/workspaces/plans?${query}&includeForecast=true`:null);
    const [details,setDetails]=useState('');
    const [drafts, setDrafts] = useState<Record<string, string>>({}), [versions, setVersions] = useState<Record<string, number>>({}), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
    useEffect(() => { setDrafts({}); setVersions({}); setNotice(''); }, [department, month]);
    if (loading)
        return <p>Загрузка плана и факта…</p>;
    if (error)
        return <p role="alert">{error}</p>;
    if (!data)
        return null;
    const rows = [...data.rows, ...(data.total ? [data.total] : [])].map(row=>({...row,values:row.values.map((metric:any)=>{const source=[...(forecast.data?.rows||[]),...(forecast.data?.total?[forecast.data.total]:[])].find((r:any)=>r.id===row.id)?.values.find((v:any)=>v.metric===metric.metric);return {...metric,forecast:source?.forecast??null,forecastDelta:source?.forecast!=null&&metric.plan!=null?source.forecast-metric.plan:null};})}));
    async function save(row: any, metric: any, key: string) { setSaving(true); try {
        const saved = await api<{
            version: number;
        }>('/workspaces/plans', { method: 'PATCH', body: JSON.stringify({ department, month, targetType: row.id === data.total?.id ? 'GROUP' : 'MANAGER', targetId: row.id, metric: metric.metric, value: drafts[key], version: versions[key] }) });
        const plan = Number(drafts[key]);
        setData((old: any) => { const patch = (target: any) => target?.id !== row.id ? target : { ...target, values: target.values.map((v: any) => v.metric !== metric.metric ? v : { ...v, plan, version: saved.version, completion: plan ? v.fact / plan * 100 : null, remaining: Math.max(plan - v.fact, 0) }) }; return { ...old, rows: old.rows.map(patch), total: patch(old.total) }; });
        setDrafts(old => { const next = { ...old }; delete next[key]; return next; });
        setNotice('План сохранён. Факт обновляется автоматически.');
    }
    catch (e) {
        setNotice(errorText(e));
    }
    finally {
        setSaving(false);
    } }
    return <><h1 className="page-title">План по оплатам и отгрузкам</h1><p className="text-sm muted">{data.paymentDefinition}</p><DataStatus value={data.dataStatus}/>{data.incompleteShipments && <p role="status">Часть отгрузок ещё не связана с продажами. Персональный результат может быть неполным.</p>}{notice && <p role="status">{notice}</p>}
    {forecast.error&&<p role="alert">Прогноз недоступен: {forecast.error}. Подтверждённый факт показан отдельно.</p>}
    {data.planReconciliation&&<div className="overflow-x-auto"><table className="data-table mb-4"><caption>Согласование планов отдела и сотрудников</caption><thead><tr><th>Показатель</th><th>Сумма личных планов</th><th>План отдела</th><th>Разница</th><th>Не задан личный план</th></tr></thead><tbody>{data.planReconciliation.map((r:any)=><tr key={r.metric}><td>{r.metric==='payments'?'Оплаты':'Отгрузки'}</td><td>{money(r.individualSum)}</td><td>{money(r.departmentPlan)}</td><td>{money(r.difference)}</td><td>{r.missingPlans}</td></tr>)}</tbody></table></div>}
    <div className="overflow-x-auto"><table className={`data-table ${data.canEdit?'':'personal-plan-table'}`}><thead><tr>{[...(data.canEdit?['Сотрудник']:[]), 'Показатель', 'План', 'Факт', 'Выполнение', 'Осталось', 'Прогноз месяца', 'Отклонение от плана', ...(data.canEdit?['Изменить план']:[])].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{rows.flatMap((row: any) => row.values.map((m: any) => { const key = `${row.id}:${m.metric}`; return <tr key={key}>{data.canEdit&&<td>{row.name}</td>}<td>{m.metric === 'payments' ? 'Оплаты' : 'Отгрузки'}</td><td>{m.plan == null ? 'План не задан' : money(m.plan)}</td><td>{money(m.fact)}</td><td>{m.completion == null ? 'Не рассчитывается' : `${m.completion.toFixed(1)}%`}</td><td>{money(m.remaining)}</td><td>{m.forecast == null ? forecast.loading?'Расчёт…':'Не рассчитан' : money(m.forecast)}</td><td>{money(m.forecastDelta)}</td>{data.canEdit&&<td><div className="flex gap-2"><input type="number" min="0" className="field" aria-label={`План ${row.name}: ${m.metric === 'payments' ? 'оплаты' : 'отгрузки'}`} value={drafts[key] ?? String(m.plan ?? '')} onChange={e => { if (!(key in drafts))
        setVersions(old => ({ ...old, [key]: m.version })); setDrafts(old => ({ ...old, [key]: e.target.value })); }}/><button className="btn" disabled={saving || !(key in drafts)} onClick={() => void save(row, m, key)}>Сохранить</button></div></td>}</tr>; }))}</tbody></table></div>
    <div className="flex gap-3 mt-4"><button className="btn" onClick={()=>setDetails(details==='payments'?'':'payments')}>Из чего состоит факт оплат</button><button className="btn" onClick={()=>setDetails(details==='shipments'?'':'shipments')}>Из чего состоит факт отгрузок</button></div>
    {details==='payments'&&<ReportPanel query={query} keys={[department==='sales'?'sales_funnel_steps':'csm_funnel']} amoDomain={amoDomain} renderReport={renderReport}/>}
    {details==='shipments'&&<Deals query={`${query}&shipped=true`} amoDomain={amoDomain}/>}
    </>;
}
function ReportPanel({ query, keys, amoDomain, renderReport }: {
    query: string;
    keys: string[];
    amoDomain: string;
    renderReport: ReportRenderer;
}) {
    const [key, setKey] = useState(keys[0] || '');
    const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('');
    const selected = keys.includes(key) ? key : keys[0];
    const { data, error, loading } = useResource<any>(`/workspaces/reports/${selected}?${query}`);
    async function exportReport() { setExporting(true); setExportError(''); try {
        const job = await api<{
            jobId: string;
        }>(`/workspaces/reports/${selected}/export?${query}`, { method: 'POST' });
        const started = Date.now();
        while (Date.now() - started < 120000) {
            const status = await api<{
                status: string;
                error?: string;
            }>(`/workspaces/exports/${job.jobId}`);
            if (status.status === 'SUCCESS') {
                await downloadFile(`/workspaces/exports/${job.jobId}/download`, 'report.xlsx');
                return;
            }
            if (status.status === 'ERROR')
                throw new Error(status.error || 'Не удалось подготовить выгрузку');
            await new Promise(resolve => window.setTimeout(resolve, 1500));
        }
        throw new Error('Подготовка выгрузки ещё не завершена.');
    }
    catch (e) {
        setExportError(errorText(e));
    }
    finally {
        setExporting(false);
    } }
    return <><h1 className="page-title">{selected === 'revenue_profit_forecast' ? 'Прогноз до конца месяца' : labels[selected] || 'Отчёт'}</h1><label><span className="label">Отчёт</span><select className="field mb-4" value={selected} onChange={e => setKey(e.target.value)}>{keys.map(k => <option key={k} value={k}>{labels[k] || 'Прогноз до конца месяца'}</option>)}</select></label>
    <button className="btn mb-4" disabled={exporting || loading || Boolean(error)} onClick={() => void exportReport()}>{exporting ? 'Подготовка выгрузки…' : 'Скачать Excel'}</button>{exportError && <p role="alert">{exportError}</p>}
    {data?.incompleteShipments&&<p role="status">Прогноз включает только отгрузки с подтверждённым продавцом. Есть нераспределённые сборки; персональный результат может быть неполным.</p>}
    {loading ? <p>Расчёт отчёта…</p> : error ? <p role="alert">{error}</p> : data ? <><DataStatus value={data.dataStatus}/>{selected === 'revenue_profit_forecast' && data.paymentProjection && <p>Ожидаемые дополнительные оплаты до конца месяца: {money(data.paymentProjection.expectedOpenAmount)}. Это оценка, не подтверждённая оплата.</p>}{renderReport(data, selected, amoDomain)}</> : <p>Нет данных</p>}</>;
}
function DataStatus({value}:{value?:{cutoffAt:string|null;checkedAt:string|null;status:string;reason?:string|null}}){
    if(!value)return null;
    const stale=!value.cutoffAt||Date.now()-+new Date(value.cutoffAt)>180000;
    const status=value.status==='BLOCKED'?'Выявлено расхождение':stale?'Источник давно не обновлялся':value.status==='CERTIFIED'?'Сверка источника пройдена':value.reason||'Полнота данных пока не подтверждена';
    return <p role="status" className="text-sm muted">{status}. Данные расчёта: {date(value.cutoffAt)}. Проверка: {date(value.checkedAt)}.</p>;
}
function Deals({ query, amoDomain }: {
    query: string;
    amoDomain: string;
}) {
    const shipped=query.includes('shipped=true');
    const [kind, setKind] = useState(shipped?'shipments':'sales'), [attention, setAttention] = useState(!shipped), [stage, setStage] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1);
    useEffect(() => { setPage(1); }, [query, kind, stage, search, attention]);
    const { data, error, loading } = useResource<any>(`/workspaces/deals?${query}&${new URLSearchParams({ kind, attention: String(attention), stage, search, page: String(page) })}`);
    return <><h1 className="page-title">Текущие сделки</h1><div className="flex flex-wrap gap-3 mb-4"><label><span className="label">Воронка</span><select className="field" value={kind} onChange={e => { setKind(e.target.value); setStage(''); }}><option value="sales">Рабочая воронка</option><option value="shipments">Отгрузки</option></select></label><label><span className="label">Показать</span><select className="field" value={String(attention)} onChange={e => setAttention(e.target.value === 'true')}><option value="true">Требуют внимания</option><option value="false">Все</option></select></label><label><span className="label">Поиск</span><input className="field" value={search} onChange={e => setSearch(e.target.value)}/></label><label><span className="label">Этап</span><select className="field" value={stage} onChange={e => setStage(e.target.value)}><option value="">Все этапы</option>{data?.stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
    {loading ? <p>Загрузка сделок…</p> : error ? <p role="alert">{error}</p> : data && <><p>Найдено: {data.total}. Сумма: {money(data.amount)}. Без оценки срока: {data.unknown}.</p><div className="overflow-x-auto"><table className="data-table"><thead><tr>{['Сделка', 'Этап', 'Сумма', 'Дней на этапе', 'Срок, дней', 'Просрочка, дней', 'Причина', 'Ответственный в сборке'].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{data.rows.map((r: any) => <tr key={r.id}><td><a target="_blank" rel="noreferrer" href={`https://${amoDomain}.amocrm.ru/leads/detail/${r.externalId}`}>{r.title}</a></td><td>{r.stage}</td><td>{money(r.amount)}</td><td>{r.days == null ? 'Неизвестно' : r.days.toFixed(1)}</td><td>{r.limit ?? 'Не задан'}</td><td>{r.overdueDays == null ? 'Нет оценки' : r.overdueDays.toFixed(1)}</td><td>{r.reason || 'В пределах срока'}</td><td>{r.operationalManager || '—'}</td></tr>)}</tbody></table></div>{!data.rows.length && <p>Сделок по этим условиям нет.</p>}<div className="flex items-center gap-3 mt-4"><button className="btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Назад</button><span>Страница {page}</span><button className="btn" disabled={page * 50 >= data.total} onClick={() => setPage(p => p + 1)}>Далее</button></div></>}
  </>;
}
function AdminSettings({amoDomain}:{amoDomain:string}) {
    const { data, error, loading } = useResource<any>('/workspaces/admin/access');
    const [notice, setNotice] = useState(''), [department, setDepartment] = useState('sales');
    const [newUser, setNewUser] = useState({ crmUserId: '', businessRole: 'MANAGER', departmentKey: 'sales', password: '' });
    if (loading)
        return <p>Загрузка настроек…</p>;
    if (error)
        return <p role="alert">{error}</p>;
    if (!data)
        return null;
    async function create() { try {
        await api('/workspaces/admin/access', { method: 'POST', body: JSON.stringify(newUser) });
        setNewUser({ ...newUser, password: '', crmUserId: '' });
        setNotice('Учётная запись создана');
    }
    catch (e) {
        setNotice(errorText(e));
    } }
    return <><h1 className="page-title">Доступ и сроки этапов</h1>{notice && <p role="status">{notice}</p>}
    <h2>Учётные записи</h2><div className="overflow-x-auto"><table className="data-table"><thead><tr>{['Сотрудник', 'Роль', 'Отдел', 'Учётная запись amoCRM', 'Активен', 'Новый личный пароль', 'Действие'].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{data.users.map((u: any) => <AccountRow key={`${u.id}:${u.accessVersion}`} user={u} data={data} onNotice={setNotice}/>)}</tbody></table></div>
    <h2 className="mt-6">Добавить сотрудника</h2><div className="flex flex-wrap items-end gap-3"><FieldCombobox label="Сотрудник amoCRM" value={newUser.crmUserId} onChange={value=>setNewUser({...newUser,crmUserId:value})} options={data.crmUsers.map((u:any)=>({value:u.id,label:u.name}))} placeholder="Выберите сотрудника" /><label><span className="label">Роль</span><select className="field" value={newUser.businessRole} onChange={e => setNewUser({ ...newUser, businessRole: e.target.value })}><option value="MANAGER">Менеджер</option><option value="ROP">РОП</option></select></label><label><span className="label">Отдел</span><select className="field" value={newUser.departmentKey} onChange={e => setNewUser({ ...newUser, departmentKey: e.target.value })}>{data.departments.map((d: any) => <option key={d.key} value={d.key}>{d.name}</option>)}</select></label><label><span className="label">Личный пароль, от 12 символов</span><input className="field" type="password" autoComplete="new-password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })}/></label><button className="btn" onClick={() => void create()}>Создать</button></div>
    <h2 className="mt-6">Сроки по этапам</h2><label><span className="label">Отдел</span><select className="field" value={department} onChange={e => setDepartment(e.target.value)}>{data.departments.map((d: any) => <option key={d.key} value={d.key}>{d.name}</option>)}</select></label>
    <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Этап</th><th>Срок, календарных дней</th><th>Контроль включён</th><th>Действие</th></tr></thead><tbody>{data.stages.filter((s: any) => { const d = data.departments.find((d: any) => d.key === department); return d && [...d.pipelineIds, d.assemblyPipelineId].includes(s.pipelineId); }).map((s: any) => <StageRule key={`${department}:${s.id}`} department={department} stage={s} rule={data.rules.find((r: any) => r.departmentKey === department && r.stageId === s.id)} onNotice={setNotice}/>)}</tbody></table></div>
    <h2 className="mt-6">Связи отгрузок</h2><p>Без подтверждённого продавца: {data.unresolved}. Такие отгрузки не назначаются по имени клиента или сумме.</p><UnassignedShipments crmUsers={data.commercialSellers||data.crmUsers} amoDomain={amoDomain}/>
  </>;
}
function UnassignedShipments({crmUsers,amoDomain}:{crmUsers:Array<{id:string;name:string}>;amoDomain:string}){
    const [month,setMonth]=useState(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date())),[page,setPage]=useState(1),[selected,setSelected]=useState(''),[sale,setSale]=useState(''),[seller,setSeller]=useState(''),[confirmed,setConfirmed]=useState(false),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
    const [basis,setBasis]=useState('relevant');
    const {data,error,loading,setData}=useResource<any>(`/workspaces/admin/unassigned?${new URLSearchParams({month,page:String(page),basis})}`);
    const [allocationConfirmed,setAllocationConfirmed]=useState(false);
    async function save(){setSaving(true);setNotice('');try{
        await api('/workspaces/admin/shipment-links',{method:'POST',body:JSON.stringify({shipmentDealId:selected,sourceExternalId:sale,managerId:seller,confirmed,allocationConfirmed})});
        setData((old:any)=>({...old,total:old.total-1,rows:old.rows.filter((r:any)=>r.id!==selected)}));setSelected('');setConfirmed(false);setNotice('Связь подтверждена. Сборка будет учитываться за выбранным продавцом; изменение записано в журнал.');
    }catch(e){setNotice(errorText(e));}finally{setSaving(false);}}
    return <><div className="flex flex-wrap gap-3"><label><span className="label">Месяц проверки</span><input className="field" type="month" value={month} onChange={e=>{setMonth(e.target.value);setPage(1);setSelected('');}}/></label>
      <label><span className="label">Какие сборки проверить</span><select className="field" value={basis} onChange={e=>{setBasis(e.target.value);setPage(1);setSelected('');}}><option value="relevant">Открытые и отгруженные за месяц</option><option value="created">Созданные за месяц</option></select></label></div>{notice&&<p role="status">{notice}</p>}
    {loading?<p>Загрузка неподтверждённых связей…</p>:error?<p role="alert">{error}</p>:data&&<>
      <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Сборка в amoCRM</th><th>Сумма</th><th>Что не подтверждено</th><th>Действие</th></tr></thead>
      <tbody>{data.rows.map((r:any)=><tr key={r.id}>
        <td><a target="_blank" rel="noreferrer" href={`https://${amoDomain}.amocrm.ru/leads/detail/${r.externalId}`}>{r.title} (№ {r.externalId})</a></td>
        <td>{money(r.amount)}</td><td>{r.reason}</td><td><button className="btn" onClick={()=>{setSelected(r.id);setSale(r.sourceExternalId||'');setSeller('');setConfirmed(false);setAllocationConfirmed(false);}}>Указать исходную продажу</button></td>
      </tr>)}</tbody></table></div>
      {!data.rows.length&&<p>За выбранный месяц неподтверждённых связей нет.</p>}
      <div className="flex gap-3 items-center mt-3"><button className="btn" disabled={page===1} onClick={()=>setPage(p=>p-1)}>Назад</button><span>Страница {page}</span><button className="btn" disabled={page*data.pageSize>=data.total} onClick={()=>setPage(p=>p+1)}>Далее</button></div>
    </>}
    {selected&&<form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void save();}}>
      <h3 className="w-full">Подтвердить связь: {data?.rows.find((r:any)=>r.id===selected)?.title}</h3>
      <label><span className="label">Ссылка или номер исходной продажи</span><input className="field" required value={sale} onChange={e=>setSale(e.target.value)}/></label>
      <FieldCombobox label="Коммерческий продавец на момент создания сборки" value={seller} options={crmUsers.map(u=>({value:u.id,label:u.name}))} onChange={setSeller} placeholder="Выберите продавца"/>
      <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Я сверил продажу и сборку в amoCRM</label>
      <label><input type="checkbox" checked={allocationConfirmed} onChange={e=>setAllocationConfirmed(e.target.checked)}/> Если сборок несколько, суммы частей проверены и не дублируются</label>
      <button className="btn" disabled={saving||!confirmed||!seller||!sale} type="submit">{saving?'Сохранение…':'Подтвердить связь'}</button><button className="btn" type="button" disabled={saving} onClick={()=>setSelected('')}>Отмена</button>
    </form>}
    </>;
}
function AccountRow({ user, data, onNotice }: {
    user: any;
    data: any;
    onNotice: (text: string) => void;
}) {
    const [draft, setDraft] = useState({ ...user, password: '' }), [saving, setSaving] = useState(false);
    async function save() { setSaving(true); try {
        await api(`/workspaces/admin/access/${user.id}`, { method: 'PATCH', body: JSON.stringify({ ...draft, version: user.accessVersion }) });
        setDraft({ ...draft, password: '' });
        onNotice('Права сохранены');
    }
    catch (e) {
        onNotice(errorText(e));
    }
    finally {
        setSaving(false);
    } }
    return <tr><td>{user.name}</td><td><select aria-label={`Роль ${user.name}`} className="field" value={draft.businessRole} onChange={e => setDraft({ ...draft, businessRole: e.target.value })}><option value="OWNER">Администратор</option><option value="ROP">РОП</option><option value="MANAGER">Менеджер</option></select></td><td><select aria-label={`Отдел ${user.name}`} className="field" value={draft.departmentKey || ''} onChange={e => setDraft({ ...draft, departmentKey: e.target.value })}><option value="">Не назначен</option>{data.departments.map((d: any) => <option key={d.key} value={d.key}>{d.name}</option>)}</select></td><td><FieldCombobox label={`Привязка ${user.name}`} value={draft.crmUserId||''} onChange={value=>setDraft({...draft,crmUserId:value})} options={[{value:'',label:'Нет привязки'},...data.crmUsers.map((u:any)=>({value:u.id,label:u.name}))]} placeholder="Сотрудник amoCRM" /></td><td><input type="checkbox" aria-label={`Активен ${user.name}`} checked={draft.isActive} onChange={e => setDraft({ ...draft, isActive: e.target.checked })}/></td><td><input className="field" type="password" aria-label={`Новый пароль ${user.name}`} autoComplete="new-password" value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })}/></td><td><button className="btn" disabled={saving} onClick={() => void save()}>Сохранить</button></td></tr>;
}
function StageRule({ department, stage, rule, onNotice }: {
    department: string;
    stage: any;
    rule: any;
    onNotice: (text: string) => void;
}) {
    const [days, setDays] = useState(String(rule?.slaDays ?? '')), [enabled, setEnabled] = useState(rule?.isEnabled ?? true), [saving, setSaving] = useState(false);
    async function save() { setSaving(true); try {
        await api('/workspaces/admin/stage-rule', { method: 'PATCH', body: JSON.stringify({ departmentKey: department, stageId: stage.id, isEnabled: enabled, slaDays: days }) });
        onNotice('Срок этапа сохранён');
    }
    catch (e) {
        onNotice(errorText(e));
    }
    finally {
        setSaving(false);
    } }
    return <tr><td>{stage.pipeline?.name?`${stage.pipeline.name}: `:''}{stage.name}</td><td><input className="field" type="number" min="1" max="3650" disabled={!enabled} aria-label={`Срок ${stage.name}`} value={days} onChange={e => setDays(e.target.value)}/></td><td><input type="checkbox" aria-label={`Контроль ${stage.name}`} checked={enabled} onChange={e => setEnabled(e.target.checked)}/></td><td><button className="btn" disabled={saving} onClick={() => void save()}>Сохранить</button></td></tr>;
}
