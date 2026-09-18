import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Play, RefreshCw, Settings, X } from 'lucide-react';
import { api, apiUrl, getToken } from '@/lib/api';
import type {
  ControlConfig, ControlDecision, ControlDepartment, ControlEvidence, ControlManager,
  ControlObservation, ControlObservationDetail, ControlPage, ControlResult, ControlRun,
  ControlRunDetail, ControlScope, ControlSettings,
} from './crm-control-types';
import './crm-control.css';

const base = '/crm-control';
const departmentNames: Record<ControlDepartment, string> = { sales: 'ОПНК', csm: 'ОППК' };
const runNames: Record<ControlRun['status'], string> = {
  QUEUED: 'В очереди', RUNNING: 'Выполняется', COMPLETED: 'Завершена', PARTIAL: 'Проверена частично', ERROR: 'Ошибка проверки',
};
const resultNames: Record<ControlResult['status'], string> = {
  PASS: 'Пройдено', FAIL: 'Нарушение', REVIEW: 'На разборе', UNKNOWN: 'Не проверено', NA: 'Не применяется',
};
const caseNames = { OPEN: 'Не исправлено', REVIEW: 'На разборе', DISPUTED: 'Оспорено', EXEMPTED: 'Исключение согласовано', RESOLVED: 'Закрыто', SUPERSEDED: 'Условия изменились' };
const decisionNames = { CONFIRM: 'Подтвердить нарушение', EXEMPT: 'Согласовать исключение', DISPUTE: 'Оспорить' };
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const activeRun = (run: ControlRun | undefined) => run?.status === 'QUEUED' || run?.status === 'RUNNING';
const effectiveStatus = (result: ControlResult) => result.effectiveStatus ?? result.status;

function errorText(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try {
    const body = JSON.parse(error.message) as { statusCode?: number; message?: string | string[] };
    if (body.statusCode === 403) return 'Нет доступа к этому действию. Обратитесь к владельцу платформы.';
    if (body.statusCode === 401) return 'Сессия истекла. Войдите в платформу заново.';
    if (Array.isArray(body.message)) return body.message.join('. ');
    return body.message || fallback;
  } catch {
    return error.message === 'Failed to fetch' ? 'Сервер недоступен. Проверьте соединение и повторите попытку.' : error.message || fallback;
  }
}

function dateTime(value?: string | null, timeZone = 'Europe/Moscow') {
  if (!value) return 'Не зафиксировано';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Дата недоступна';
  return date.toLocaleString('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function unique<T extends { id: string }>(items: T[]) {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

type Choice = { value: string; label: string };
function SearchSelect({ label, value, choices, onChange, placeholder = 'Выберите', disabled = false, allowEmpty = false }: {
  label: string; value: string; choices: Choice[]; onChange: (value: string) => void; placeholder?: string; disabled?: boolean; allowEmpty?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selected = choices.find(choice => choice.value === value);
  const filtered = choices.filter(choice => choice.label.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  return <div className="field-combobox" onBlur={event => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
  }}>
    <span className="label" id={`${id}-label`}>{label}</span>
    <button ref={buttonRef} type="button" className="field-combobox-trigger" disabled={disabled} aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-options`} onClick={() => setOpen(current => !current)}>
      <span id={`${id}-value`} className="truncate">{selected?.label ?? (value ? 'Выбранный элемент недоступен' : placeholder)}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="field-combobox-panel crm-option-panel" id={`${id}-options`}>
      <input className="field-combobox-search" aria-label={`Поиск: ${label}`} placeholder="Поиск" autoFocus value={query} onChange={event => setQuery(event.target.value)} />
      <div className="field-combobox-list">
        {allowEmpty && <button type="button" className="field-combobox-option" onClick={() => { onChange(''); setOpen(false); buttonRef.current?.focus(); }}>Не задано</button>}
        {filtered.map(choice => <button key={choice.value} type="button" className={`field-combobox-option ${choice.value === value ? 'active' : ''}`} onClick={() => { onChange(choice.value); setOpen(false); setQuery(''); buttonRef.current?.focus(); }}>{choice.label}</button>)}
        {!filtered.length && <p className="crm-note p-3">{choices.length ? 'Совпадений нет' : 'Справочник пока пуст'}</p>}
      </div>
    </div>}
  </div>;
}

export default function CrmControl() {
  const [settings, setSettings] = useState<ControlSettings | null>(null);
  const [runs, setRuns] = useState<ControlRun[]>([]);
  const [runsCursor, setRunsCursor] = useState<string | null>(null);
  const [runId, setRunId] = useState('');
  const [detail, setDetail] = useState<ControlRunDetail | null>(null);
  const [manager, setManager] = useState<ControlManager | null>(null);
  const [department, setDepartment] = useState('all');
  const [query, setQuery] = useState('');
  const [deals, setDeals] = useState<ControlObservation[]>([]);
  const [dealsCursor, setDealsCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ observationId: string; resultId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [dealsLoading, setDealsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runError, setRunError] = useState('');
  const [dealsError, setDealsError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const selectionRef = useRef('');
  const requestRef = useRef(0);
  const finishedRunRef = useRef('');
  const timeZone = settings?.config.timeZone || 'Europe/Moscow';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextSettings, nextRuns] = await Promise.all([
        api<ControlSettings>(`${base}/settings`), api<ControlPage<ControlRun>>(`${base}/runs`),
      ]);
      setSettings(nextSettings);
      setRuns(nextRuns.items);
      setRunsCursor(nextRuns.nextCursor);
      setRunId(current => nextRuns.items.some(run => run.id === current) ? current : (nextRuns.items.find(activeRun) ?? nextRuns.items.find(run => run.status === 'COMPLETED' || run.status === 'PARTIAL') ?? nextRuns.items[0])?.id || '');
    } catch (err) { setError(errorText(err, 'Не удалось загрузить контроль CRM')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadRun = useCallback(async (id: string, quiet = false) => {
    if (!id) return;
    if (!quiet) setRunLoading(true);
    setRunError('');
    try {
      const next = await api<ControlRunDetail>(`${base}/runs/${encodeURIComponent(id)}`);
      if (selectionRef.current !== id) return;
      setDetail(next);
      setRuns(current => current.map(run => run.id === id ? next.run : run));
    } catch (err) { if (selectionRef.current === id) setRunError(errorText(err, 'Не удалось загрузить проверку')); }
    finally { if (selectionRef.current === id) setRunLoading(false); }
  }, []);

  useEffect(() => {
    selectionRef.current = runId;
    setDetail(null); setManager(null); setDeals([]); setSelected(null);
    if (runId) void loadRun(runId);
  }, [runId, loadRun]);

  useEffect(() => {
    if (!detail || !activeRun(detail.run)) return;
    const timer = window.setInterval(() => void loadRun(runId, true), 5000);
    return () => window.clearInterval(timer);
  }, [detail?.run.status, runId, loadRun]);

  const loadDeals = useCallback(async (selectedManager: ControlManager, cursor?: string | null) => {
    const request = ++requestRef.current;
    setDealsLoading(true); setDealsError('');
    const params = new URLSearchParams({ managerId: selectedManager.managerId || 'unassigned', department: selectedManager.department });
    if (cursor) params.set('cursor', cursor);
    try {
      const next = await api<ControlPage<ControlObservation>>(`${base}/runs/${encodeURIComponent(runId)}/deals?${params}`);
      if (request !== requestRef.current) return;
      setDeals(current => cursor ? unique([...current, ...next.items]) : next.items);
      setDealsCursor(next.nextCursor);
    } catch (err) { if (request === requestRef.current) setDealsError(errorText(err, 'Не удалось загрузить сделки')); }
    finally { if (request === requestRef.current) setDealsLoading(false); }
  }, [runId]);

  useEffect(() => {
    ++requestRef.current;
    setDeals([]); setDealsCursor(null); setSelected(null);
    if (manager) void loadDeals(manager);
  }, [manager, loadDeals]);

  useEffect(() => {
    const finishedAt = detail?.run.finishedAt || '';
    if (finishedRunRef.current === finishedAt) return;
    finishedRunRef.current = finishedAt;
    if (manager && finishedAt) void loadDeals(manager);
  }, [detail?.run.finishedAt, manager, loadDeals]);

  const visibleManagers = useMemo(() => (detail?.managers || []).filter(item =>
    (department === 'all' || item.department === department)
    && `${item.managerName} ${item.groupName}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')),
  ), [detail?.managers, department, query]);

  async function startRun() {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<ControlRun>(`${base}/runs`, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID() }) });
      setRuns(current => unique([next, ...current])); setRunId(next.id);
      setNotice('Проверка поставлена в очередь. Результаты появятся здесь.');
    } catch (err) { setError(errorText(err, 'Не удалось запустить проверку')); }
    finally { setBusy(false); }
  }

  async function moreRuns() {
    if (!runsCursor) return;
    setBusy(true);
    try {
      const next = await api<ControlPage<ControlRun>>(`${base}/runs?cursor=${encodeURIComponent(runsCursor)}`);
      setRuns(current => unique([...current, ...next.items])); setRunsCursor(next.nextCursor);
    } catch (err) { setError(errorText(err, 'Не удалось загрузить историю')); }
    finally { setBusy(false); }
  }

  return <section className="crm-control" aria-label="Контроль ведения CRM">
    <div className="page-head">
      <h1 className="page-title">Контроль CRM</h1>
      <div className="crm-actions">
        <button type="button" className="btn" onClick={() => { void load(); if (runId) void loadRun(runId); }} disabled={loading || busy}><RefreshCw size={15} aria-hidden="true" />Обновить</button>
        <button type="button" className="btn" aria-expanded={showRules} onClick={() => setShowRules(current => !current)}>Правила</button>
        {settings?.canManage && <button type="button" className="btn" aria-expanded={showSettings} onClick={() => setShowSettings(current => !current)}><Settings size={15} aria-hidden="true" />Настройки</button>}
        {settings?.canReview && <button type="button" className="btn btn-primary" disabled={busy || loading || Boolean(runs.some(activeRun)) || !settings.config.scopes.length} onClick={() => void startRun()}><Play size={15} aria-hidden="true" />{busy ? 'Подождите…' : 'Проверить сейчас'}</button>}
      </div>
    </div>
    {error && <div role="alert" className="crm-status crm-status-error"><AlertCircle size={17} />{error}</div>}
    {notice && <div role="status" className="crm-status crm-status-success"><CheckCircle2 size={17} />{notice}</div>}
    {loading && !settings && <p role="status" className="crm-muted">Загрузка проверок…</p>}
    {settings && <>
      <p className="crm-note">{settings.config.enabled ? `Автоматическая проверка: ${settings.config.timeOfDay}, ${settings.config.timeZone}; ${settings.config.workdays.map(day => weekdays[day - 1]).join(', ')}.` : 'Автоматическая проверка выключена.'} Проверка фиксирует состояние на фактическое время обращения к amoCRM.</p>
      {!!settings.configurationIssues.length && <div className="crm-status crm-status-warning"><AlertCircle size={17} /><div><p>Настройка проверки не завершена.</p><ul className="crm-error-list">{settings.configurationIssues.map(issue => <li key={issue}>{issue}</li>)}</ul></div></div>}
      {!settings.capabilities.screenshots && <div className="crm-status crm-status-warning"><AlertCircle size={17} /><p>Сохранение скриншотов не подключено. Факты проверки сохраняются; скриншоты будут помечены как недоступные.</p></div>}
      {showRules && <RuleCatalog settings={settings} />}
      {showSettings && settings.canManage && <SettingsEditor settings={settings} onSaved={next => { setSettings(next); setNotice('Настройки контроля CRM сохранены.'); }} onClose={() => setShowSettings(false)} />}
      {runs.length > 0 && <div className="crm-toolbar">
        <div style={{ minWidth: 240, maxWidth: '100%', flex: '0 1 410px' }}><SearchSelect label="Проверка" value={runId} choices={runs.map(run => ({ value: run.id, label: `${dateTime(run.startedAt || run.scheduledFor, timeZone)} · ${runNames[run.status]}` }))} onChange={setRunId} /></div>
        <label><span className="label">Отдел</span><select className="select" value={department} onChange={event => { setDepartment(event.target.value); setManager(null); }}><option value="all">Все отделы</option><option value="sales">ОПНК</option><option value="csm">ОППК</option></select></label>
        <label className="crm-search"><span className="label">Менеджер или группа</span><input className="field" type="search" value={query} onChange={event => { setQuery(event.target.value); setManager(null); }} placeholder="Поиск" /></label>
        {runsCursor && <button type="button" className="btn" disabled={busy} onClick={() => void moreRuns()}>Более ранние проверки</button>}
      </div>}
      {!runs.length && !loading && !error && <div className="crm-empty"><h2>Проверок пока нет</h2><p className="crm-muted">{settings.config.scopes.length ? 'Запустите проверку вручную или включите расписание в настройках.' : 'Сначала сопоставьте воронки и этапы amoCRM в настройках.'}</p>{!settings.canManage && <p className="crm-note">Настроить проверку может владелец платформы.</p>}</div>}
      {runError && <div role="alert" className="crm-status crm-status-error"><AlertCircle size={17} />{runError}<button className="crm-link" type="button" onClick={() => void loadRun(runId)}>Повторить</button></div>}
      {runLoading && !detail && <p role="status" className="crm-muted">Загрузка результатов…</p>}
      {detail && <>
        {activeRun(detail.run) && <p role="status" className="crm-status">{runNames[detail.run.status]}. Результаты обновляются автоматически; незавершённая проверка не означает отсутствие нарушений.</p>}
        {detail.run.error && <div role="alert" className="crm-status crm-status-error">{detail.run.error}</div>}
        {detail.run.status === 'PARTIAL' && <p className="crm-status crm-status-warning">Проверка завершена не полностью. Недоступные данные не засчитываются как пройденные проверки.</p>}
        {!!detail.configurationIssues.length && <details className="crm-disclosure"><summary>Ограничения этой проверки</summary><ul className="crm-error-list">{detail.configurationIssues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
        <p className="crm-note">Начало: {dateTime(detail.run.startedAt, timeZone)} · Завершение: {dateTime(detail.run.finishedAt, timeZone)}. Последняя синхронизация: {dateTime(detail.run.sourceSyncAt, timeZone)}.</p>
        {visibleManagers.length > 0 ? <><p className="crm-note crm-mobile-scroll-hint">Прокрутите таблицу вправо, чтобы увидеть нарушения и разбор.</p><div className="crm-table-scroll" role="region" aria-label="Результаты по менеджерам, таблица с горизонтальной прокруткой" tabIndex={0}><table className="crm-table crm-manager-table"><thead><tr>
          <th scope="col">Менеджер</th><th scope="col" className="crm-number">Сделок<br />в проверке</th><th scope="col" className="crm-number">Полностью<br />проверено</th><th scope="col" className="crm-number">С нарушениями</th><th scope="col" className="crm-number">Не исправлено</th><th scope="col" className="crm-number">На разборе</th><th scope="col" className="crm-number">Не проверено</th>
        </tr></thead><tbody>{visibleManagers.map(item => {
          const isSelected = manager?.managerId === item.managerId && manager?.department === item.department;
          return <tr key={`${item.department}:${item.managerId}`} className={isSelected ? 'crm-selected-row' : ''}>
            <td><button type="button" className="crm-link" aria-expanded={isSelected} onClick={() => setManager(isSelected ? null : item)}>{isSelected ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{item.managerName || 'Без ответственного'}</button><p className="crm-note">{departmentNames[item.department]}{item.groupName ? ` · ${item.groupName}` : ''}</p></td>
            <td className="crm-number">{item.deals}</td><td className="crm-number">{item.checkedDeals}</td><td className={`crm-number ${item.failedDeals ? 'crm-danger' : ''}`}>{item.failedDeals}</td><td className="crm-number">{item.unresolvedDeals}</td><td className={`crm-number ${item.reviewDeals ? 'crm-warning' : ''}`}>{item.reviewDeals}</td><td className="crm-number">{item.unknownDeals}</td>
          </tr>;
        })}</tbody></table></div></> : !activeRun(detail.run) && <p className="crm-empty">{detail.managers.length ? 'По выбранному отделу и поиску менеджеры не найдены.' : 'В этой проверке нет доступных вам сделок.'}</p>}
        <p className="crm-note">Все колонки — уникальные сделки. «Полностью проверено» — без неопределённых результатов и разбора. Одна сделка может иметь нарушение и другой непроверенный пункт. Исправление не удаляет факт нарушения из прошлой проверки.</p>
      </>}
      {manager && <section className="grid gap-3" aria-label={`Сделки: ${manager.managerName}`}>
        <div className="crm-section-head"><h2>{manager.managerName || 'Без ответственного'} · {departmentNames[manager.department]}</h2><button type="button" className="crm-link" onClick={() => { setManager(null); setSelected(null); }}>Свернуть сделки</button></div>
        {dealsError && <div role="alert" className="crm-status crm-status-error">{dealsError}<button type="button" className="crm-link" onClick={() => void loadDeals(manager)}>Повторить</button></div>}
        {deals.length > 0 && <div className="crm-deal-list">{deals.map(deal => <article className="crm-deal" key={deal.id}>
          <div className="crm-section-head"><div><a className="crm-link" href={deal.dealUrl} target="_blank" rel="noreferrer">{deal.dealTitle}<ExternalLink size={13} aria-label="Открыть в amoCRM" /></a><p className="crm-note">{deal.pipelineName} · {deal.stageName} · № {deal.dealExternalId}</p></div><span className="crm-note">Зафиксировано {dateTime(deal.observedAt, timeZone)}</span></div>
          <div className="crm-findings">{deal.results.filter(result => effectiveStatus(result) !== 'NA' && effectiveStatus(result) !== 'PASS').map(result => <button type="button" key={result.id} className={`crm-link ${selected?.resultId === result.id ? 'crm-finding-selected' : ''}`} aria-pressed={selected?.resultId === result.id} onClick={() => setSelected({ observationId: deal.id, resultId: result.id })}>{result.ruleName} <span className={effectiveStatus(result) === 'FAIL' ? 'crm-danger' : 'crm-warning'}>— {resultNames[effectiveStatus(result)]}{result.caseStatus && ['RESOLVED', 'EXEMPTED', 'SUPERSEDED', 'DISPUTED'].includes(result.caseStatus) ? ` · ${caseNames[result.caseStatus]}` : ''}</span></button>)}</div>
          <details className="crm-disclosure"><summary>Все результаты по сделке</summary><div className="crm-findings">{deal.results.map(result => <button className="crm-link" type="button" key={result.id} onClick={() => setSelected({ observationId: deal.id, resultId: result.id })}>{result.ruleName} — {resultNames[effectiveStatus(result)]}</button>)}</div></details>
        </article>)}</div>}
        {dealsLoading && <p role="status" className="crm-note">Загрузка сделок…</p>}
        {!dealsLoading && !deals.length && !dealsError && <p className="crm-empty">В этой проверке сделки менеджера не найдены.</p>}
        {dealsCursor && <button type="button" className="btn justify-self-start" disabled={dealsLoading} onClick={() => void loadDeals(manager, dealsCursor)}>Показать ещё сделки</button>}
      </section>}
      {selected && <ObservationDetail key={selected.observationId} observationId={selected.observationId} resultId={selected.resultId} settings={settings} onClose={() => setSelected(null)} onDecision={() => { void loadRun(runId, true); if (manager) void loadDeals(manager); }} />}
    </>}
  </section>;
}

function RuleCatalog({ settings }: { settings: ControlSettings }) {
  return <section className="grid gap-3" aria-label="Регламент проверки"><h2>Правила проверки</h2><p className="crm-note">Результат зависит от наличия данных. Проверки переписки, договорённостей и содержимого КП требуют разбора; отсутствие доступа не считается успехом.</p>
    <div className="crm-table-scroll"><table className="crm-table crm-catalog"><thead><tr><th scope="col">Требование</th><th scope="col">Пункты письма</th><th scope="col">Как проверяется</th></tr></thead><tbody>{settings.ruleCatalog.map(rule => <tr key={rule.code}><td>{rule.name}</td><td>{rule.clauses.join(', ')}</td><td>{rule.mode === 'automatic' ? 'Автоматически при наличии данных' : 'С разбором подтверждений'}</td></tr>)}</tbody></table></div>
  </section>;
}

function EvidenceImage({ evidence, timeZone, canCapture, onRetried }: { evidence: ControlEvidence; timeZone: string; canCapture: boolean; onRetried: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  async function retryCapture() {
    setRetrying(true); setError('');
    try {
      await api(`${base}/evidence/${encodeURIComponent(evidence.id)}/retry`, { method: 'POST' });
      await onRetried();
    } catch (err) { setError(errorText(err, 'Не удалось повторить сохранение скриншота')); }
    finally { setRetrying(false); }
  }
  useEffect(() => {
    if (evidence.status !== 'READY') return;
    const controller = new AbortController();
    let objectUrl = '';
    setError(''); setUrl('');
    void (async () => {
      try {
        const response = await fetch(apiUrl(`${base}/evidence/${encodeURIComponent(evidence.id)}/file`), { signal: controller.signal, headers: { Authorization: `Bearer ${getToken()}` } });
        if (!response.ok) throw new Error(await response.text());
        const imageData = await response.blob(); // slop-check: allow ai-decor — бинарное тело ответа со скриншотом, не декоративный элемент.
        if (!imageData.type.startsWith('image/')) throw new Error('Сервер вернул файл, который не является изображением.');
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(imageData); setUrl(objectUrl);
      } catch (err) { if (!controller.signal.aborted) setError(errorText(err, 'Не удалось открыть скриншот')); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [evidence.id, evidence.status, attempt]);
  if (evidence.status === 'DISABLED' || evidence.status === 'ERROR') return <div className="grid gap-2"><p className={`crm-status ${evidence.status === 'ERROR' ? 'crm-status-error' : 'crm-status-warning'}`}>{evidence.status === 'DISABLED' ? 'Скриншот не сохранён: сервис захвата был недоступен.' : `Скриншот не получен. ${evidence.error || 'Причина недоступна.'}`}</p>{canCapture && <><button type="button" className="btn justify-self-start" disabled={retrying} onClick={() => void retryCapture()}>{retrying ? 'Постановка в очередь…' : 'Получить снимок сейчас'}</button><p className="crm-note">Снимок покажет текущее состояние карточки. Сохранённые факты прошлой проверки не изменятся.</p></>}{error && <p role="alert" className="crm-danger">{error}</p>}</div>;
  if (evidence.status === 'PENDING' || evidence.status === 'RUNNING') return <p role="status" className="crm-note">Скриншот {evidence.status === 'PENDING' ? 'ожидает сохранения' : 'сохраняется'}…</p>;
  return <figure>{error ? <div role="alert" className="crm-status crm-status-error">{error}<button type="button" className="crm-link" onClick={() => setAttempt(current => current + 1)}>Повторить</button></div> : url ? <a href={url} target="_blank" rel="noreferrer" aria-label="Открыть сохранённый скриншот целиком"><img src={url} alt="Сохранённая карточка сделки amoCRM в момент захвата" /></a> : <p role="status" className="crm-note">Загрузка скриншота…</p>}<figcaption className="crm-note">Скриншот: {dateTime(evidence.capturedAt, timeZone)}. Его время может отличаться от времени проверки.{evidence.coverage ? ` ${evidence.coverage}` : ''}</figcaption></figure>;
}

function ObservationDetail({ observationId, resultId, settings, onClose, onDecision }: {
  observationId: string; resultId: string; settings: ControlSettings; onClose: () => void; onDecision: () => void;
}) {
  const [data, setData] = useState<ControlObservationDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<ControlDecision['action']>(settings.canReview ? 'CONFIRM' : 'DISPUTE');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [saved, setSaved] = useState('');
  const titleId = useId();
  const reasonId = useId();
  const load = useCallback(async () => {
    try { setData(await api<ControlObservationDetail>(`${base}/observations/${encodeURIComponent(observationId)}`)); setError(''); }
    catch (err) { setError(errorText(err, 'Не удалось загрузить доказательства')); }
  }, [observationId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setReason(''); setSaved(''); setUntil(''); }, [resultId]);
  useEffect(() => {
    if (!data?.evidence.some(item => item.status === 'PENDING' || item.status === 'RUNNING')) return;
    const timer = window.setInterval(() => void load(), 7000);
    return () => window.clearInterval(timer);
  }, [data?.evidence, load]);
  const result = data?.results.find(item => item.id === resultId);
  const currentCase = data?.cases.find(item => item.id === result?.caseId);
  const tz = settings.config.timeZone;

  async function decide(event: FormEvent) {
    event.preventDefault();
    if (!currentCase || !reason.trim()) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const validUntil = action === 'EXEMPT' && until ? new Date(until).toISOString() : undefined;
      await api(`${base}/cases/${encodeURIComponent(currentCase.id)}/decisions`, { method: 'POST', body: JSON.stringify({ action, reason: reason.trim(), validUntil }) });
      setReason(''); setSaved('Решение сохранено в истории случая.'); await load(); onDecision();
    } catch (err) { setError(errorText(err, 'Не удалось сохранить решение')); }
    finally { setBusy(false); }
  }

  return <section className="crm-detail" aria-labelledby={titleId}>
    <div className="crm-section-head"><h2 id={titleId}>{result?.ruleName || 'Доказательства проверки'}</h2><button type="button" className="btn btn-ghost" onClick={onClose}><X size={15} aria-hidden="true" />Закрыть</button></div>
    {error && <div role="alert" className="crm-status crm-status-error">{error}<button type="button" className="crm-link" onClick={() => void load()}>Обновить</button></div>}
    {!data && !error && <p role="status" className="crm-note">Загрузка сохранённых фактов…</p>}
    {data && !result && <p className="crm-note">Этот результат проверки недоступен. Выберите другой пункт сделки.</p>}
    {data && result && <>
      <p>{result.message}</p>
      <div className="crm-proof-grid"><div className="grid gap-4"><h3>На момент проверки</h3><dl className="crm-facts">
        <dt>Результат</dt><dd>{resultNames[result.status]}</dd><dt>Сделка</dt><dd>{data.dealTitle} · № {data.dealExternalId}</dd><dt>Ответственный</dt><dd>{data.managerName}</dd><dt>Этап</dt><dd>{data.pipelineName} · {data.stageName}</dd><dt>Зафиксировано</dt><dd>{dateTime(data.observedAt, tz)}</dd><dt>Пункты письма</dt><dd>{result.clauses.join(', ')}</dd>
        {result.details && Object.entries(result.details).map(([key, value]) => <FactValue key={key} name={key} value={value} timeZone={tz} />)}
      </dl></div><div className="crm-evidence"><h3>Сохранённые подтверждения</h3>{data.evidence.length ? data.evidence.map(item => <EvidenceImage key={item.id} evidence={item} timeZone={tz} canCapture={settings.capabilities.screenshots} onRetried={load} />) : <p className="crm-note">Для этого результата скриншот не сохранён.</p>}</div></div>
      {currentCase && <div className="grid gap-2"><h3>Текущее состояние случая</h3><p>{caseNames[currentCase.status]}{currentCase.resolvedAt ? ` · ${dateTime(currentCase.resolvedAt, tz)}` : ''}</p>{currentCase.resolutionReason && <p className="crm-note">{currentCase.resolutionReason}</p>}<p className="crm-note">Первое обнаружение: {dateTime(currentCase.firstDetectedAt, tz)}. Последнее: {dateTime(currentCase.lastDetectedAt, tz)}. Это состояние может меняться; результат проверки выше остаётся в истории.</p></div>}
      <details className="crm-disclosure"><summary>Сохранённые задачи и примечания</summary><SnapshotData snapshot={data.snapshot} timeZone={tz} /></details>
      {currentCase && !['RESOLVED', 'SUPERSEDED'].includes(currentCase.status) && (settings.canReview || settings.canDispute) && <form className="crm-decision-form" onSubmit={event => void decide(event)}><h3>Решение по случаю</h3><div className="crm-decision-fields"><label><span className="label">Решение</span><select className="select" value={action} onChange={event => setAction(event.target.value as ControlDecision['action'])}>{(settings.canReview ? ['CONFIRM', 'EXEMPT', 'DISPUTE'] as const : ['DISPUTE'] as const).map(value => <option key={value} value={value}>{decisionNames[value]}</option>)}</select></label><label htmlFor={reasonId}><span className="label">Причина и подтверждение</span><textarea id={reasonId} className="textarea" value={reason} required minLength={5} maxLength={4000} onChange={event => setReason(event.target.value)} placeholder="Укажите причину и где находится подтверждение" /></label></div>{action === 'EXEMPT' && <label><span className="label">Исключение действует до (время вашего устройства)</span><input type="datetime-local" className="field" value={until} required onChange={event => setUntil(event.target.value)} /></label>}<div><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 5 || (action === 'EXEMPT' && (!until || new Date(until).getTime() <= Date.now()))}>{busy ? 'Сохранение…' : 'Сохранить решение'}</button></div>{saved && <p role="status" className="crm-success">{saved}</p>}</form>}
      {!!currentCase?.decisions.length && <details className="crm-disclosure"><summary>История решений</summary><div className="grid gap-3">{currentCase.decisions.map(decision => <div key={decision.id}><p>{decisionNames[decision.action]} · {decision.actorName || 'Пользователь платформы'}</p><p>{decision.reason}</p><p className="crm-note">{dateTime(decision.createdAt, tz)}{decision.validUntil ? ` · Действует до ${dateTime(decision.validUntil, tz)}` : ''}</p></div>)}</div></details>}
    </>}
  </section>;
}

const factLabels: Record<string, string> = {
  taskText: 'Текст задачи', maximumDueAt: 'Предельный срок задачи', dueToday: 'Назначена на день проверки', overdue: 'Просрочена', allowedMinimum: 'Минимум задач', allowedMaximum: 'Максимум задач', cutoffLocalTime: 'Граница создания сделки', timeZone: 'Часовой пояс', agePolicy: 'Расчёт возраста',
  taskCount: 'Открытых задач', count: 'Количество', activeTaskCount: 'Открытых задач', taskId: 'Задача', taskTitle: 'Текст задачи', taskTypeId: 'Тип задачи', dueAt: 'Срок задачи', createdAt: 'Создана', createdBefore: 'Создана до', cutoff: 'Граница проверки', cutoffAt: 'Граница проверки', observedAt: 'Время проверки', ageDays: 'Возраст, дней', maxAgeDays: 'Допустимый возраст, дней', ageLimit: 'Допустимый возраст', threshold: 'Порог', thresholdAt: 'Граница возраста', stageEnteredAt: 'Вход на этап', durationHours: 'Время на этапе, ч', elapsedHours: 'Время на этапе, ч', maxDurationHours: 'Допустимое время, ч', allowedTaskTypeIds: 'Допустимые типы задач', noteCount: 'Примечаний', amount: 'Бюджет', source: 'Источник', reason: 'Причина', taskIds: 'Задачи', missing: 'Недостающие данные', limit: 'Ограничение', deadline: 'Предельный срок', taskDeadline: 'Срок задачи', notes: 'Примечания', task: 'Задача', tasks: 'Задачи', noteIds: 'Примечания', completeness: 'Полнота данных', expected: 'Ожидается', actual: 'Зафиксировано', maxHours: 'Предельный срок, ч', ageMode: 'Расчёт возраста', deadlineAt: 'Предельный срок', stageAgeHours: 'На этапе, ч', taskDueAt: 'Срок задачи', actualTypeId: 'Тип задачи', allowedTypeIds: 'Допустимые типы', noteText: 'Текст примечания', boundaryAt: 'Граница возраста', requires: 'Требуется', unsupported: 'Недоступно',
};
function FactValue({ name, value, timeZone }: { name: string; value: unknown; timeZone: string }) {
  if (value === null || value === undefined || typeof value === 'object' && !Array.isArray(value)) return null;
  const label = factLabels[name];
  if (!label) return null;
  const text = Array.isArray(value) ? value.filter(item => typeof item !== 'object').join(', ') : typeof value === 'boolean' ? (value ? 'Да' : 'Нет') : String(value);
  if (!text) return null;
  const display = /^\d{4}-\d{2}-\d{2}T/.test(text) ? dateTime(text, timeZone) : text === 'calendar_month' ? 'Календарный месяц' : text === '30_days' ? '30 дней' : text;
  return <><dt>{label}</dt><dd>{display}</dd></>;
}
function SnapshotData({ snapshot, timeZone }: { snapshot: Record<string, unknown>; timeZone: string }) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks as Array<Record<string, unknown>> : [];
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes as Array<Record<string, unknown>> : [];
  return <div className="grid gap-3"><p className="crm-note">Чтение данных: {dateTime(String(snapshot.sourceReadStartedAt || ''), timeZone)} — {dateTime(String(snapshot.sourceReadFinishedAt || ''), timeZone)}.</p><h3>Задачи</h3>{tasks.length ? tasks.map((task, index) => <div key={String(task.id || index)}><p>{String(task.title || task.text || 'Без текста')}</p><p className="crm-note">{task.isCompleted ? 'Завершена' : 'Не завершена'} · Срок: {dateTime(String(task.dueAt || ''), timeZone)}{task.typeId ? ` · Тип № ${String(task.typeId)}` : ''}</p></div>) : <p className="crm-note">В сохранённых данных задач нет. Полнота получения данных учитывается в результате проверки.</p>}<h3>Примечания</h3>{notes.length ? notes.map((note, index) => <div key={String(note.id || index)}><p className="whitespace-pre-wrap break-words">{String(note.text || 'Без текстового содержимого')}</p><p className="crm-note">{dateTime(String(note.createdAt || ''), timeZone)}</p></div>) : <p className="crm-note">В сохранённых данных примечаний нет.</p>}</div>;
}

function SettingsEditor({ settings, onSaved, onClose }: { settings: ControlSettings; onSaved: (settings: ControlSettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<ControlConfig>(() => structuredClone(settings.config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const update = (patch: Partial<ControlConfig>) => { setDraft(current => ({ ...current, ...patch })); setSaved(false); };
  const updateScope = (index: number, scope: ControlScope) => update({ scopes: draft.scopes.map((item, i) => i === index ? scope : item) });
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      const next = await api<ControlSettings>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(draft) });
      setDraft(structuredClone(next.config)); onSaved(next); setSaved(true);
    } catch (err) { setError(errorText(err, 'Не удалось сохранить настройки')); }
    finally { setBusy(false); }
  }
  return <form className="crm-settings" onSubmit={event => void save(event)} aria-label="Настройки контроля CRM">
    <div className="crm-section-head"><h2>Настройки проверки</h2><button type="button" className="btn btn-ghost" onClick={onClose}><X size={15} aria-hidden="true" />Закрыть</button></div>
    <fieldset className="crm-settings-group"><legend>Расписание</legend><div className="crm-form-grid crm-form-grid-three"><label><span className="label">Время запуска</span><input type="time" className="field" value={draft.timeOfDay} required onChange={event => update({ timeOfDay: event.target.value })} /></label><label><span className="label">Часовой пояс</span><input className="field" value={draft.timeZone} required onChange={event => update({ timeZone: event.target.value })} /><span className="crm-note">Например, Europe/Moscow</span></label><label><span className="label">Максимальный возраст сделки</span><select className="select" value={draft.maxDealAge} onChange={event => update({ maxDealAge: event.target.value as ControlConfig['maxDealAge'] })}><option value="calendar_month">Один календарный месяц</option><option value="30_days">30 дней</option></select></label></div><div className="crm-checks mt-4" role="group" aria-label="Дни проверки">{weekdays.map((day, index) => <label className="crm-check" key={day}><input type="checkbox" checked={draft.workdays.includes(index + 1)} onChange={event => update({ workdays: event.target.checked ? [...draft.workdays, index + 1].sort() : draft.workdays.filter(value => value !== index + 1) })} />{day}</label>)}</div><label className="crm-check mt-4"><input type="checkbox" checked={draft.excludeBaseFromAge} onChange={event => update({ excludeBaseFromAge: event.target.checked })} />Не проверять возраст сделок на этапе «База»</label></fieldset>
    <fieldset className="crm-settings-group"><legend>Воронки и этапы amoCRM</legend><div className="crm-config-list">{draft.scopes.map((scope, index) => <ScopeEditor key={`${index}:${scope.pipelineId}`} scope={scope} settings={settings} onChange={next => updateScope(index, next)} onRemove={() => update({ scopes: draft.scopes.filter((_, i) => i !== index) })} />)}</div><div className="crm-actions mt-4"><button type="button" className="btn" onClick={() => update({ scopes: [...draft.scopes, { department: 'sales', pipelineId: '', stageRules: {} }] })}>Добавить воронку</button>{!draft.scopes.length && settings.suggestedScopes.length > 0 && <button type="button" className="btn" onClick={() => update({ scopes: structuredClone(settings.suggestedScopes) })}>Подставить найденные воронки</button>}</div>{!settings.options.pipelines.length && <p className="crm-note mt-3">Воронки появятся после подключения и синхронизации amoCRM.</p>}</fieldset>
    <fieldset className="crm-settings-group"><legend>Автоматический запуск</legend><label className="crm-check"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />Проверять по расписанию</label><p className="crm-note mt-2">Для включения выберите воронки. Неуказанные этапы, сроки и типы задач попадут в «Не проверено»; остальные правила выполнятся.</p></fieldset>
    {error && <div role="alert" className="crm-status crm-status-error">{error}</div>}{saved && <p role="status" className="crm-success">Настройки сохранены.</p>}<div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить настройки'}</button></div>
  </form>;
}

function ScopeEditor({ scope, settings, onChange, onRemove }: { scope: ControlScope; settings: ControlSettings; onChange: (scope: ControlScope) => void; onRemove: () => void }) {
  const pipeline = settings.options.pipelines.find(item => item.id === scope.pipelineId);
  const stages = pipeline?.stages.filter(stage => !stage.isWon && !stage.isLost) || [];
  const choices = stages.map(stage => ({ value: stage.id, label: stage.name }));
  const [newStage, setNewStage] = useState('');
  const stageFields: Array<{ key: 'assignedStageId' | 'newClientStageId' | 'baseStageId' | 'preparedProposalStageId' | 'priceRequestedStageId'; label: string }> = scope.department === 'sales'
    ? [{ key: 'assignedStageId', label: 'Назначен ответственный' }, { key: 'preparedProposalStageId', label: 'КП подготовлено' }]
    : [{ key: 'newClientStageId', label: 'Новый клиент' }, { key: 'baseStageId', label: 'База' }, { key: 'preparedProposalStageId', label: 'КП подготовлено' }, { key: 'priceRequestedStageId', label: 'Цена запрошена' }];
  const changeRule = (stageId: string, rule: NonNullable<ControlScope['stageRules']>[string]) => onChange({ ...scope, stageRules: { ...scope.stageRules, [stageId]: rule } });
  return <section className="crm-stage-rule">
    <div className="crm-config-row"><label><span className="label">Отдел</span><select className="select" value={scope.department} onChange={event => onChange({ department: event.target.value as ControlDepartment, pipelineId: scope.pipelineId, stageRules: scope.stageRules })}><option value="sales">ОПНК</option><option value="csm">ОППК</option></select></label><SearchSelect label="Воронка" value={scope.pipelineId} choices={settings.options.pipelines.map(item => ({ value: item.id, label: item.name }))} onChange={pipelineId => onChange({ department: scope.department, pipelineId, stageRules: {} })} /><button className="btn btn-ghost" type="button" onClick={onRemove}>Убрать воронку</button></div>
    {!!scope.pipelineId && <><div className="crm-form-grid">{stageFields.map(field => <SearchSelect key={field.key} label={`Этап «${field.label}»`} choices={choices} value={scope[field.key] || ''} allowEmpty onChange={value => onChange({ ...scope, [field.key]: value || undefined })} />)}</div>
      <details className="crm-disclosure"><summary>Сроки и типы задач по этапам</summary><div className="grid gap-4 mt-3">
        <p className="crm-note">Срок отсчитывается от входа на этап. Без установленного срока или типа соответствующий пункт остаётся непроверенным.</p>
        {Object.entries(scope.stageRules || {}).map(([stageId, rule]) => <div className="crm-stage-rule" key={stageId}><div className="crm-section-head"><h3>{stages.find(stage => stage.id === stageId)?.name || 'Этап больше недоступен'}</h3><button type="button" className="crm-link" onClick={() => { const next = { ...scope.stageRules }; delete next[stageId]; onChange({ ...scope, stageRules: next }); }}>Убрать регламент</button></div><StageDurationField value={rule.maxDurationHours} onChange={maxDurationHours => changeRule(stageId, { ...rule, maxDurationHours })} /><TaskTypePicker options={settings.options.taskTypes} selected={rule.allowedTaskTypeIds || []} onChange={allowedTaskTypeIds => changeRule(stageId, { ...rule, allowedTaskTypeIds })} /></div>)}
        <div className="crm-config-row"><SearchSelect label="Этап для регламента" choices={choices.filter(choice => !scope.stageRules?.[choice.value])} value={newStage} onChange={setNewStage} /><button type="button" className="btn" disabled={!newStage} onClick={() => { changeRule(newStage, {}); setNewStage(''); }}>Добавить регламент</button></div>
      </div></details>
    </>}
  </section>;
}

const durationHoursPerUnit = { minutes: 1 / 60, hours: 1, days: 24 };
type DurationUnit = keyof typeof durationHoursPerUnit;

function StageDurationField({ value, onChange }: { value: number | undefined; onChange: (hours: number | undefined) => void }) {
  const [unit, setUnit] = useState<DurationUnit>(() => value !== undefined && value > 0
    ? Number.isInteger(value / 24) ? 'days' : Number.isInteger(value) ? 'hours' : 'minutes'
    : 'hours');
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const displayValue = value === undefined ? '' : Number((value / durationHoursPerUnit[unit]).toPrecision(12));
  useEffect(() => {
    inputRef.current?.setCustomValidity(value !== undefined && value <= 0 ? 'Укажите время больше нуля.' : '');
  }, [value]);
  return <div className="crm-duration-field">
    <div><label className="label" htmlFor={`${id}-value`}>Максимальное время на этапе</label><input id={`${id}-value`} ref={inputRef} className="field" type="number" min="0" step="any" value={displayValue} onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value) * durationHoursPerUnit[unit])} /></div>
    <div><label className="label" htmlFor={`${id}-unit`}>Единица времени</label><select id={`${id}-unit`} className="select" value={unit} onChange={event => setUnit(event.target.value as DurationUnit)}><option value="minutes">Минуты</option><option value="hours">Часы</option><option value="days">Дни</option></select></div>
  </div>;
}

function TaskTypePicker({ options, selected, onChange }: { options: Array<{ id: number; name: string }>; selected: number[]; onChange: (ids: number[]) => void }) {
  const [query, setQuery] = useState('');
  const visible = options.filter(option => option.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  const id = useId();
  return <div><label htmlFor={id} className="label">Допустимые типы задачи</label><input id={id} className="field" type="search" placeholder="Поиск типов" value={query} onChange={event => setQuery(event.target.value)} /><div className="crm-checks mt-3">{visible.map(option => <label key={option.id} className="crm-check"><input type="checkbox" checked={selected.includes(option.id)} onChange={event => onChange(event.target.checked ? [...selected, option.id] : selected.filter(value => value !== option.id))} />{option.name}</label>)}</div>{!visible.length && <p className="crm-note mt-2">{options.length ? 'По запросу типов не найдено.' : 'Справочник типов задач недоступен. Выполните синхронизацию amoCRM.'}</p>}</div>;
}
