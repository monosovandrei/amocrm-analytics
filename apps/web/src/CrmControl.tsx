import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Play, RefreshCw, Settings, X } from 'lucide-react';
import { api, apiUrl, getToken } from '@/lib/api';
import type {
  ControlConfig, ControlDeadlineMode, ControlDecision, ControlDepartment, ControlEvidence, ControlEvidenceManifest, ControlManager,
  ControlObservation, ControlObservationDetail, ControlOfferAnalysis, ControlOfferCitation, ControlPage, ControlResult, ControlRun,
  ControlRunDetail, ControlScope, ControlSettings, ControlStageRule, ControlRuleBreakdown,
} from './crm-control-types';
import './crm-control.css';

const base = '/crm-control';
const departmentNames: Record<ControlDepartment, string> = { sales: 'ОПНК', csm: 'ОППК' };
const runNames: Record<ControlRun['status'], string> = {
  QUEUED: 'В очереди', RUNNING: 'Выполняется', COMPLETED: 'Автоматическая обработка завершена', PARTIAL: 'Автоматическая обработка завершена', ERROR: 'Ошибка проверки',
};
const completionName = (run: ControlRun) => run.completion?.status === 'CHECKED' ? 'Проверено' : 'Не проверено';
type RuleStatus = 'FAIL' | 'REVIEW' | 'UNKNOWN';
const ruleStatusFields = { FAIL: 'failedDeals', REVIEW: 'reviewDeals', UNKNOWN: 'unknownDeals' } as const;
type DealSelection = { anchor: HTMLButtonElement; title: string; count: number; ruleCode: string; status: RuleStatus; manager: ControlManager };
const resultNames: Record<ControlResult['status'], string> = {
  PASS: 'Пройдено', FAIL: 'Нарушение', REVIEW: 'На разборе', UNKNOWN: 'Не проверено', NA: 'Не применяется',
};
const caseNames = { OPEN: 'Не исправлено', REVIEW: 'На разборе', DISPUTED: 'Оспорено', EXEMPTED: 'Исключение согласовано', RESOLVED: 'Закрыто', SUPERSEDED: 'Условия изменились' };
const decisionNames = { CONFIRM: 'Подтвердить нарушение', EXEMPT: 'Согласовать исключение', DISPUTE: 'Оспорить', VERIFY_PASS: 'Допроверка: пройдено', VERIFY_FAIL: 'Допроверка: нарушение', VERIFY_NA: 'Допроверка: не применяется' };
const deadlineModeLabels: Record<ControlDeadlineMode, string> = {
  elapsed: 'Промежуток времени', business_days: 'Рабочие дни',
  end_of_day: 'До 19:00 в день входа', unlimited: 'Без ограничения',
};
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
        {allowEmpty && <button type="button" className="field-combobox-option" onClick={() => { onChange(''); setOpen(false); buttonRef.current?.focus(); }}>Выберите</button>}
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
  const [view, setView] = useState<'managers' | 'rules'>('managers');
  const [ruleStatus, setRuleStatus] = useState<RuleStatus>('FAIL');
  const [dealSelection, setDealSelection] = useState<DealSelection | null>(null);
  const selectionRef = useRef('');
  const requestRef = useRef(0);
  const finishedRunRef = useRef('');
  const timeZone = settings?.config.timeZone || 'Europe/Moscow';
  const analysisActive = Boolean(detail?.analysis && (detail.analysis.preparing || detail.analysis.queued || detail.analysis.running));

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
  useEffect(() => { setDealSelection(null); }, [department, query, view, ruleStatus]);

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
    setDetail(null); setManager(null); setDeals([]); setSelected(null); setDealSelection(null);
    if (runId) void loadRun(runId);
  }, [runId, loadRun]);

  useEffect(() => {
    if (!detail || (!activeRun(detail.run) && !analysisActive)) return;
    const timer = window.setInterval(() => void loadRun(runId, true), 5000);
    return () => window.clearInterval(timer);
  }, [detail?.run.status, analysisActive, runId, loadRun]);

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

  async function startRun(sourceRunId?: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<ControlRun>(`${base}/runs`, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID(), ...(sourceRunId ? { sourceRunId } : {}) }) });
      setRuns(current => unique([next, ...current])); setRunId(next.id);
      setNotice(next.scope && next.scope.kind !== 'ALL' ? `${next.scope.label}. Проверка этой области поставлена в очередь; результаты сохранятся отдельно.`
        : sourceRunId ? 'Новый полный обход поставлен в очередь. Он прочитает текущее состояние CRM и сохранит отдельную проверку; допроверка прежних фактов выполняется отдельно.' : 'Проверка поставлена в очередь. Результаты появятся здесь.');
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

  async function continueAnalysis() {
    if (!runId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`${base}/runs/${encodeURIComponent(runId)}/recheck-remaining`, { method: 'POST', body: JSON.stringify({ requestKey: crypto.randomUUID() }) });
      setNotice('Допроверка сохранённых данных поставлена в очередь. Результаты обновляются автоматически.');
      await loadRun(runId, true);
    } catch (err) { setError(errorText(err, 'Не удалось продолжить проверку')); }
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
        <div className="crm-run-picker" style={{ minWidth: 240, maxWidth: '100%', flex: '0 1 410px' }}><SearchSelect label="Проверка" value={runId} choices={runs.map(run => ({ value: run.id, label: `${dateTime(run.startedAt || run.scheduledFor, timeZone)} · ${completionName(run)}${activeRun(run) ? ` · ${runNames[run.status]}` : ''}${run.scope ? ` · ${run.scope.label}` : ''}` }))} onChange={setRunId} /></div>
        <label><span className="label">Отдел</span><select className="select" value={department} onChange={event => { setDepartment(event.target.value); setManager(null); }}><option value="all">Все отделы</option><option value="sales">ОПНК</option><option value="csm">ОППК</option></select></label>
        <label className="crm-search"><span className="label">Менеджер или группа</span><input className="field" type="search" value={query} onChange={event => { setQuery(event.target.value); setManager(null); }} placeholder="Поиск" /></label>
        {runsCursor && <button type="button" className="btn" disabled={busy} onClick={() => void moreRuns()}>Более ранние проверки</button>}
      </div>}
      {!runs.length && !loading && !error && <div className="crm-empty"><h2>Проверок пока нет</h2><p className="crm-muted">{settings.config.scopes.length ? 'Запустите проверку вручную или включите расписание в настройках.' : 'Сначала сопоставьте воронки и этапы amoCRM в настройках.'}</p>{!settings.canManage && <p className="crm-note">Настроить проверку может владелец платформы.</p>}</div>}
      {runError && <div role="alert" className="crm-status crm-status-error"><AlertCircle size={17} />{runError}<button className="crm-link" type="button" onClick={() => void loadRun(runId)}>Повторить</button></div>}
      {runLoading && !detail && <p role="status" className="crm-muted">Загрузка результатов…</p>}
      {detail && <>
        <section className={`crm-completion ${detail.run.completion?.status === 'CHECKED' ? 'crm-completion-checked' : ''}`} aria-label="Итог проверки">
          <div className="crm-section-head"><h2>{completionName(detail.run)}</h2>{activeRun(detail.run) && <span role="status" className="crm-note">{runNames[detail.run.status]}. Результаты обновляются автоматически.</span>}</div>
          {detail.run.completion?.status === 'CHECKED' ? <p className="crm-note">Все применимые правила в выбранной области проверки получили определённый результат. Найденные нарушения показаны в таблице.</p> : <>
            {detail.run.completion?.reasons.length ? <ul className="crm-error-list">{detail.run.completion.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}>{reason.message}</li>)}</ul> : <p className="crm-note">{detail.run.error || (activeRun(detail.run) ? 'Обработка ещё не завершена.' : 'Итог полной проверки недоступен. Обновите результаты; отсутствие итога не считается успешной проверкой.')}</p>}
            <div className="crm-actions">
              {(detail.counts.unknown > 0 || detail.counts.review > 0) && <>
                {settings.canReview && settings.capabilities.localAnalysis && <button className="btn" type="button" disabled={busy || analysisActive} onClick={() => void continueAnalysis()}>Допроверить оставшиеся</button>}
                <button className="crm-link" type="button" onClick={() => { setView('rules'); setRuleStatus(detail.counts.unknown > 0 ? 'UNKNOWN' : 'REVIEW'); setManager(null); }}>Показать непроверенное</button>
              </>}
              {settings.canReview && detail.run.completion?.canRecheck && <><button className="btn" type="button" disabled={busy || Boolean(runs.some(activeRun))} onClick={() => void startRun(detail.run.id)}><RefreshCw size={14} aria-hidden="true" />Проверить заново</button><span className="crm-note">{detail.run.scope?.kind === 'MANAGER' ? 'Новый обход сделок этого менеджера.' : 'Новый обход CRM в вашей области доступа.'} Не заменяет разбор недоступных источников.</span></>}
            </div>
            {analysisActive && <p className="crm-note" role="status">Локальная допроверка: {detail.analysis?.preparing ? 'подготовка источников; ' : ''}в очереди {detail.analysis?.queued ?? 0}, выполняется {detail.analysis?.running ?? 0}. Проверено пунктов: {detail.analysis?.completed ?? 0}.</p>}
          </>}
        </section>
        {!!detail.configurationIssues.length && <details className="crm-disclosure"><summary>Настройки, влияющие на эту проверку</summary><ul className="crm-error-list">{detail.configurationIssues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
        <p className="crm-note">Начало: {dateTime(detail.run.startedAt, timeZone)} · Завершение: {dateTime(detail.run.finishedAt, timeZone)}. Последняя синхронизация: {dateTime(detail.run.sourceSyncAt, timeZone)}.</p>
        <div className="crm-view-controls"><div className="crm-view-switch" role="group" aria-label="Представление результатов"><button type="button" className={`btn ${view === 'managers' ? 'crm-view-active' : ''}`} aria-pressed={view === 'managers'} onClick={() => { setView('managers'); setSelected(null); }}>По менеджерам</button><button type="button" className={`btn ${view === 'rules' ? 'crm-view-active' : ''}`} aria-pressed={view === 'rules'} onClick={() => { setView('rules'); setManager(null); setSelected(null); }}>По типам ошибок</button></div>{view === 'rules' && <label><span className="label">Результат правил</span><select className="select" value={ruleStatus} onChange={event => setRuleStatus(event.target.value as RuleStatus)}><option value="FAIL">Подтверждённые нарушения</option><option value="REVIEW">Нужен разбор</option><option value="UNKNOWN">Не проверено</option></select></label>}</div>
        {view === 'rules' ? <RuleBreakdown rows={detail.ruleBreakdown} managers={visibleManagers} status={ruleStatus} onSelect={setDealSelection} /> : visibleManagers.length > 0 ? <><p className="crm-note crm-mobile-scroll-hint">Прокрутите таблицу вправо, чтобы увидеть нарушения и разбор.</p><div className="crm-table-scroll" role="region" aria-label="Результаты по менеджерам, таблица с горизонтальной прокруткой" tabIndex={0}><table className="crm-table crm-manager-table"><thead><tr>
          <th scope="col">Менеджер</th><th scope="col" className="crm-number">Сделок<br />в проверке</th><th scope="col" className="crm-number">Полностью<br />проверено</th><th scope="col" className="crm-number">С нарушениями</th><th scope="col" className="crm-number">Не исправлено</th><th scope="col" className="crm-number">На разборе</th><th scope="col" className="crm-number">Не проверено</th>
        </tr></thead><tbody>{visibleManagers.map(item => {
          const isSelected = manager?.managerId === item.managerId && manager?.department === item.department;
          return <tr key={`${item.department}:${item.managerId}`} className={isSelected ? 'crm-selected-row' : ''}>
            <td><button type="button" className="crm-link" aria-expanded={isSelected} onClick={() => setManager(isSelected ? null : item)}>{isSelected ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{item.managerName || 'Без ответственного'}</button><p className="crm-note">{departmentNames[item.department]}{item.groupName ? ` · ${item.groupName}` : ''}</p></td>
            <td className="crm-number">{item.deals}</td><td className="crm-number">{item.checkedDeals}</td><td className={`crm-number ${item.failedDeals ? 'crm-danger' : ''}`}>{item.failedDeals}</td><td className="crm-number">{item.unresolvedDeals}</td><td className={`crm-number ${item.reviewDeals ? 'crm-warning' : ''}`}>{item.reviewDeals}</td><td className="crm-number">{Math.max(0, item.deals - item.checkedDeals)}</td>
          </tr>;
        })}</tbody></table></div></> : !activeRun(detail.run) && <p className="crm-empty">{detail.managers.length ? 'По выбранному отделу и поиску менеджеры не найдены.' : 'В этой проверке нет доступных вам сделок.'}</p>}
        {view === 'managers' && <p className="crm-note">«Полностью проверено» и «Не проверено» вместе охватывают все сделки. «На разборе» — часть непроверенных. Нарушения могут пересекаться с непроверенными пунктами; эти колонки не складываются. Исправление не удаляет факт из прошлой проверки.</p>}
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
      {dealSelection && <RuleDealsPopup key={`${runId}:${dealSelection.ruleCode}:${dealSelection.status}:${dealSelection.manager.department}:${dealSelection.manager.managerId}`} selection={dealSelection} runId={runId} onClose={() => setDealSelection(null)} onSelect={(observationId, resultId) => { setDealSelection(null); setSelected({ observationId, resultId }); }} />}
    </>}
  </section>;
}

function RuleBreakdown({ rows, managers, status, onSelect }: { rows?: ControlRuleBreakdown[]; managers: ControlManager[]; status: RuleStatus; onSelect: (selection: DealSelection) => void }) {
  const field = ruleStatusFields[status];
  const countFor = (row: ControlRuleBreakdown, manager: ControlManager) => row.byManager.find(item => item.managerId === manager.managerId && item.department === manager.department)?.[field] || 0;
  const visibleRows = (rows || []).map(row => ({ row, total: managers.reduce((sum, manager) => sum + countFor(row, manager), 0) })).filter(item => item.total > 0);
  if (!rows) return <p className="crm-empty">Сводка по типам ошибок не получена. Обновите результаты проверки.</p>;
  if (!managers.length) return <p className="crm-empty">По выбранному отделу и поиску менеджеры не найдены.</p>;
  if (!visibleRows.length) return <p className="crm-empty">{status === 'FAIL' ? 'Подтверждённых нарушений по выбранным менеджерам нет.' : status === 'REVIEW' ? 'Пунктов, требующих разбора, по выбранным менеджерам нет.' : 'Непроверенных пунктов по выбранным менеджерам нет.'}</p>;
  return <section className="grid gap-3" aria-label="Результаты по типам ошибок"><p className="crm-note">Число в ячейке — уникальные сделки с этим результатом правила. Нажмите число у менеджера, чтобы открыть сделки. Одна сделка может попасть в несколько строк.</p><p className="crm-note crm-mobile-scroll-hint">Прокрутите таблицу вправо, чтобы увидеть всех менеджеров.</p><div className="crm-table-scroll" role="region" aria-label="Типы ошибок и менеджеры, таблица с горизонтальной прокруткой" tabIndex={0}><table className="crm-table crm-rule-table"><thead><tr><th scope="col">Правило</th>{managers.map(manager => <th scope="col" className="crm-number" key={`${manager.department}:${manager.managerId}`}><span>{manager.managerName || 'Без ответственного'}</span><span className="crm-note">{departmentNames[manager.department]}</span></th>)}<th scope="col" className="crm-number">Всего</th></tr></thead><tbody>{visibleRows.map(({ row, total }) => <tr key={row.ruleCode}><th scope="row">{row.ruleName}</th>{managers.map(manager => {
    const count = countFor(row, manager);
    return <td className="crm-number" key={`${manager.department}:${manager.managerId}`}>{count ? <button type="button" className="crm-link crm-count-link" aria-haspopup="dialog" aria-label={`${row.ruleName}, ${manager.managerName || 'Без ответственного'}, ${departmentNames[manager.department]}. Сделок: ${count}. Показать сделки`} onClick={event => onSelect({ anchor: event.currentTarget, title: row.ruleName, ruleCode: row.ruleCode, status, count, manager })}>{count}</button> : 0}</td>;
  })}<td className="crm-number">{total}</td></tr>)}</tbody></table></div></section>;
}

function RuleDealsPopup({ selection, runId, onClose, onSelect }: { selection: DealSelection; runId: string; onClose: () => void; onSelect: (observationId: string, resultId: string) => void }) {
  const [items, setItems] = useState<ControlObservation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 16, top: 16, maxHeight: 400 });
  const popupRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const close = (restoreFocus = false) => { if (restoreFocus) selection.anchor.focus({ preventScroll: true }); onClose(); };
  const loadPage = useCallback(async (nextCursor?: string | null) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true); setError('');
    const params = new URLSearchParams({ ruleCode: selection.ruleCode, status: selection.status, managerId: selection.manager.managerId || 'unassigned', department: selection.manager.department });
    if (nextCursor) params.set('cursor', nextCursor);
    try {
      const page = await api<ControlPage<ControlObservation>>(`${base}/runs/${encodeURIComponent(runId)}/deals?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems(current => nextCursor ? unique([...current, ...page.items]) : page.items); setCursor(page.nextCursor);
    } catch (err) { if (!controller.signal.aborted) setError(errorText(err, 'Не удалось загрузить сделки')); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [runId, selection.ruleCode, selection.status, selection.manager.managerId, selection.manager.department]);
  useEffect(() => { void loadPage(); return () => controllerRef.current?.abort(); }, [loadPage]);
  useEffect(() => { if (!loading && document.activeElement === document.body) popupRef.current?.focus({ preventScroll: true }); }, [loading]);
  useLayoutEffect(() => {
    const rect = selection.anchor.getBoundingClientRect();
    const width = Math.min(480, window.innerWidth - 32);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const showBelow = below >= 300 || below >= above;
    setPosition({ left: Math.round(Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))), ...(showBelow ? { top: Math.round(rect.bottom + 8) } : { bottom: Math.round(Math.max(8, window.innerHeight - rect.top + 8)) }), maxHeight: Math.max(120, Math.min(440, showBelow ? below : above)) });
    popupRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [selection.anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !popupRef.current?.contains(event.target) && !selection.anchor.contains(event.target)) onClose(); };
    const scroll = (event: Event) => { if (event.target instanceof Node && !popupRef.current?.contains(event.target)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); selection.anchor.focus({ preventScroll: true }); onClose(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('scroll', scroll, true); document.addEventListener('keydown', escape); window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); document.removeEventListener('keydown', escape); window.removeEventListener('resize', onClose); };
  }, [onClose, selection.anchor]);
  return createPortal(<div className="crm-control crm-deal-popup" role="dialog" aria-labelledby={titleId} ref={popupRef} tabIndex={-1} style={position} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== selection.anchor) onClose(); }}>
    <div className="crm-section-head"><h2 id={titleId}>{selection.title}</h2><button type="button" className="icon-btn" aria-label="Закрыть список сделок" onClick={() => close(true)}><X size={16} /></button></div>
    <p className="crm-note">{selection.manager.managerName || 'Без ответственного'} · {departmentNames[selection.manager.department]} · {resultNames[selection.status]} · Сделок: {selection.count}</p>
    <div className="crm-popup-list">{items.map(deal => {
      const matching = deal.results.filter(result => result.ruleCode === selection.ruleCode && effectiveStatus(result) === selection.status);
      return <div className="crm-popup-deal" key={deal.id}><a className="crm-link" href={deal.dealUrl} target="_blank" rel="noreferrer">{deal.dealTitle}<ExternalLink size={13} aria-label="Открыть в amoCRM" /></a><p className="crm-note">{deal.pipelineName} · {deal.stageName} · № {deal.dealExternalId}</p>{matching.map((result, index) => <button className="crm-link" type="button" key={result.id} onClick={() => onSelect(deal.id, result.id)}>{matching.length > 1 ? `Факты по результату ${index + 1}` : 'Факты и допроверка'}</button>)}</div>;
    })}{error && <div role="alert" className="crm-status crm-status-error">{error}<button type="button" className="crm-link" onClick={() => void loadPage(items.length ? cursor : undefined)}>Повторить</button></div>}{loading && <p role="status" className="crm-note">Загрузка сделок…</p>}{!loading && !error && !items.length && <p className="crm-note">Сделки с выбранным результатом не найдены. Результат мог измениться после допроверки; обновите сводку.</p>}{cursor && !error && <button className="btn" type="button" disabled={loading} onClick={() => void loadPage(cursor)}>Показать ещё сделки</button>}</div>
  </div>, document.body);
}

function RuleCatalog({ settings }: { settings: ControlSettings }) {
  return <section className="grid gap-3" aria-label="Регламент проверки"><h2>Правила проверки</h2><p className="crm-note">Результат зависит от наличия данных. Проверки переписки, договорённостей и содержимого КП требуют разбора; отсутствие доступа не считается успехом.</p>
    <div className="crm-table-scroll"><table className="crm-table crm-catalog"><thead><tr><th scope="col">Требование</th><th scope="col">Пункты письма</th><th scope="col">Как проверяется</th></tr></thead><tbody>{settings.ruleCatalog.map(rule => <tr key={rule.code}><td>{rule.name}</td><td>{rule.clauses.join(', ')}</td><td>{rule.mode === 'automatic' ? 'Автоматически при наличии данных' : 'С разбором подтверждений'}</td></tr>)}</tbody></table></div>
  </section>;
}

function EvidenceImage({ evidence, resultId, timeZone, canCapture, onRetried }: { evidence: ControlEvidence; resultId: string; timeZone: string; canCapture: boolean; onRetried: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [manifest, setManifest] = useState<ControlEvidenceManifest | null>(null);
  const [selectedFrame, setSelectedFrame] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const frame = manifest?.frames.find(item => item.id === selectedFrame) ?? manifest?.frames[0];
  const coverage = manifest?.coverage.find(item => item.resultId === resultId);
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
    setManifest(null); setUrl(''); setError('');
    void api<ControlEvidenceManifest>(`${base}/evidence/${encodeURIComponent(evidence.id)}/manifest`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { if (!value.frames.length) throw new Error('В архиве нет доступных кадров.'); setManifest(value); } })
      .catch(err => { if (!controller.signal.aborted) setError(errorText(err, 'Не удалось загрузить список кадров')); });
    return () => controller.abort();
  }, [evidence.id, evidence.status, attempt]);
  useEffect(() => {
    if (!manifest) return;
    const related = manifest.coverage.find(item => item.resultId === resultId)?.frameIds[0];
    setSelectedFrame(related && manifest.frames.some(item => item.id === related) ? related : manifest.frames[0]?.id ?? '');
  }, [manifest, resultId]);
  useEffect(() => {
    if (evidence.status !== 'READY' || !manifest || !frame) return;
    const controller = new AbortController();
    let objectUrl = '';
    setError(''); setUrl('');
    void (async () => {
      try {
        const filePath = manifest.version === 0 ? `${base}/evidence/${encodeURIComponent(evidence.id)}/file`
          : `${base}/evidence/${encodeURIComponent(evidence.id)}/frames/${encodeURIComponent(frame.id)}/file`;
        const response = await fetch(apiUrl(filePath), { signal: controller.signal, headers: { Authorization: `Bearer ${getToken()}` } });
        if (!response.ok) {
          let message = 'Сохранённый кадр недоступен. Повторите загрузку.';
          try { const body = await response.json(); if (typeof body.message === 'string') message = body.message; } catch { /* Keep the readable failure when the proxy response is not JSON. */ }
          throw new Error(message);
        }
        const imageData = await response.blob(); // slop-check: allow ai-decor — бинарное тело ответа со скриншотом, не декоративный элемент.
        if (!imageData.type.startsWith('image/')) throw new Error('Сервер вернул файл, который не является изображением.');
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(imageData); setUrl(objectUrl);
      } catch (err) { if (!controller.signal.aborted) setError(errorText(err, 'Не удалось открыть скриншот')); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [evidence.id, evidence.status, manifest, frame?.id, attempt]);
  if (evidence.status === 'DISABLED' || evidence.status === 'ERROR') return <div className="grid gap-2"><p className={`crm-status ${evidence.status === 'ERROR' ? 'crm-status-error' : 'crm-status-warning'}`}>{evidence.status === 'DISABLED' ? 'Скриншот не сохранён: сервис захвата был недоступен.' : `Скриншот не получен. ${evidence.error || 'Причина недоступна.'}`}</p>{canCapture && <><button type="button" className="btn justify-self-start" disabled={retrying} onClick={() => void retryCapture()}>{retrying ? 'Постановка в очередь…' : 'Получить снимок сейчас'}</button><p className="crm-note">Снимок покажет текущее состояние карточки. Сохранённые факты прошлой проверки не изменятся.</p></>}{error && <p role="alert" className="crm-danger">{error}</p>}</div>;
  if (evidence.status === 'PENDING' || evidence.status === 'RUNNING') return <p role="status" className="crm-note">Скриншот {evidence.status === 'PENDING' ? 'ожидает сохранения' : 'сохраняется'}…</p>;
  const coverageNames = { CONTEXT_ONLY: 'Контекст карточки', VISIBLE_MATCH: 'Источник совпал с сохранёнными данными',
    NOT_VISIBLE: 'Источник не попал в кадры', SOURCE_CHANGED: 'Источник изменился после проверки' };
  return <figure>{manifest && manifest.frames.length > 1 && <label><span className="label">Сохранённый кадр</span><select className="select" value={frame?.id || ''} onChange={event => setSelectedFrame(event.target.value)}>{manifest.frames.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    {coverage && <div className="grid gap-1" aria-live="polite"><p>{coverageNames[coverage.status]}</p><p className="crm-note">{coverage.reason}</p>{frame && coverage.frameIds.length > 0 && !coverage.frameIds.includes(frame.id) && <p className="crm-note">Выбран общий кадр. Источник этого пункта находится в других сохранённых кадрах.</p>}</div>}
    {error ? <div role="alert" className="crm-status crm-status-error">{error}<button type="button" className="crm-link" onClick={() => setAttempt(current => current + 1)}>Повторить</button></div> : url ? <a className="grid gap-2" href={url} target="_blank" rel="noreferrer" aria-label="Открыть сохранённый кадр целиком"><img src={url} alt={frame?.label || 'Сохранённая карточка сделки amoCRM в момент захвата'} /><span className="crm-link">Открыть кадр в полном размере<ExternalLink size={13} aria-hidden="true" /></span></a> : <p role="status" className="crm-note">{manifest ? 'Загрузка кадра…' : 'Загрузка списка кадров…'}</p>}
    <figcaption className="crm-note">Кадр снят: {dateTime(frame?.capturedAt || evidence.capturedAt, timeZone)}. Состояние на момент прошлой проверки может отличаться.{manifest?.limitation ? ` ${manifest.limitation}` : evidence.coverage ? ` ${evidence.coverage}` : ''}{manifest?.truncated ? ' Достигнут предел съёмки; часть ленты осталась за кадром.' : ''}</figcaption></figure>;
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
  const [reviewSaved, setReviewSaved] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const load = useCallback(async () => {
    try { setData(await api<ControlObservationDetail>(`${base}/observations/${encodeURIComponent(observationId)}`)); setError(''); }
    catch (err) { setError(errorText(err, 'Не удалось загрузить доказательства')); }
  }, [observationId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { sectionRef.current?.focus({ preventScroll: true }); sectionRef.current?.scrollIntoView({ block: 'start' }); }, [observationId, resultId]);
  useEffect(() => { setReason(''); setSaved(''); setReviewSaved(''); setUntil(''); }, [resultId]);
  useEffect(() => {
    if (!data?.evidence.some(item => item.status === 'PENDING' || item.status === 'RUNNING')
      && !data?.results.some(item => ['QUEUED','RUNNING'].includes(item.analysis?.status || ''))) return;
    const timer = window.setInterval(() => void load(), 7000);
    return () => window.clearInterval(timer);
  }, [data?.evidence, data?.results, load]);
  const result = data?.results.find(item => item.id === resultId);
  const linkedCase = data?.cases.find(item => item.id === result?.caseId);
  const currentCase = !result || result.status === 'UNKNOWN' || ['PASS', 'NA'].includes(effectiveStatus(result)) ? undefined : linkedCase;
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

  return <section className="crm-detail" aria-labelledby={titleId} ref={sectionRef} tabIndex={-1}>
    <div className="crm-section-head"><h2 id={titleId}>{result?.ruleName || 'Доказательства проверки'}</h2><button type="button" className="btn btn-ghost" onClick={onClose}><X size={15} aria-hidden="true" />Закрыть</button></div>
    {error && <div role="alert" className="crm-status crm-status-error">{error}<button type="button" className="crm-link" onClick={() => void load()}>Обновить</button></div>}
    {!data && !error && <p role="status" className="crm-note">Загрузка сохранённых фактов…</p>}
    {data && !result && <p className="crm-note">Этот результат проверки недоступен. Выберите другой пункт сделки.</p>}
    {data && result && <>
      <p>{result.review?.current?.reason || result.analysis?.message || result.message}</p>
      <div className="crm-proof-grid"><div className="grid gap-4"><h3>На момент проверки</h3><dl className="crm-facts">
        <dt>Результат</dt><dd>{resultNames[effectiveStatus(result)]}</dd><dt>Сделка</dt><dd>{data.dealTitle} · № {data.dealExternalId}</dd><dt>Ответственный</dt><dd>{data.managerName}</dd><dt>Этап</dt><dd>{data.pipelineName} · {data.stageName}</dd><dt>Зафиксировано</dt><dd>{dateTime(data.observedAt, tz)}</dd><dt>Пункты письма</dt><dd>{result.clauses.join(', ')}</dd>
        {result.details && Object.entries(result.details).map(([key, value]) => <FactValue key={key} name={key} value={value} timeZone={tz} />)}
      </dl></div><div className="crm-evidence"><h3>Сохранённые подтверждения</h3>{data.evidence.length ? data.evidence.map(item => <EvidenceImage key={item.id} evidence={item} resultId={result.id} timeZone={tz} canCapture={settings.capabilities.screenshots} onRetried={load} />) : <p className="crm-note">Для этого результата скриншот не сохранён.</p>}</div></div>
      {currentCase && <div className="grid gap-2"><h3>Текущее состояние случая</h3><p>{caseNames[currentCase.status]}{currentCase.resolvedAt ? ` · ${dateTime(currentCase.resolvedAt, tz)}` : ''}</p>{currentCase.resolutionReason && <p className="crm-note">{currentCase.resolutionReason}</p>}<p className="crm-note">Первое обнаружение: {dateTime(currentCase.firstDetectedAt, tz)}. Последнее: {dateTime(currentCase.lastDetectedAt, tz)}. Это состояние может меняться; результат проверки выше остаётся в истории.</p></div>}
      <details className="crm-disclosure"><summary>Сохранённые задачи и примечания</summary><SnapshotData snapshot={data.snapshot} timeZone={tz} /></details>
      {['offer_budget', 'proposal_file'].includes(result.ruleCode) && <OfferProof value={result.details?.offerAnalysis} timeZone={tz} />}
      {!!data.documents?.length && <section className="grid gap-2" aria-label="Архив документов"><h3>Документы на момент проверки</h3>
        {data.documents.map(document => <DocumentEvidence key={`${document.sha256}:${document.source}`} document={document} timeZone={tz} />)}
        <p className="crm-note">Файл из поля «КП» сам по себе не подтверждает отправку клиенту. Для сверки используется подтверждённая отправка из этой сделки.</p>
      </section>}
      {result.analysis?.outcome && <AnalysisProof key={`${result.id}:${result.analysis.id}`} observationId={observationId} resultId={result.id} timeZone={tz} />}
      {result.review?.current && <div className="grid gap-2"><h3>Результат допроверки</h3><p>{resultNames[result.review.current.outcome]} · {result.review.current.reviewedBy} · {dateTime(result.review.current.reviewedAt, tz)}</p><p className="crm-review-reason">{result.review.current.reason}</p><p className="crm-note">Решение относится к этому сохранённому результату. Исходные данные и будущие проверки не меняются.</p></div>}
      {reviewSaved && <p role="status" className="crm-success">{reviewSaved}</p>}
      {result.review && <ManualReview key={`${result.id}:${result.review.expectedDecisionId || 'initial'}`} observationId={observationId} observedAt={data.observedAt} timeZone={tz} result={result} canReview={settings.canReview} onReload={load} onSaved={async () => { await load(); setReviewSaved('Допроверка сохранена. Сводка обновляется.'); onDecision(); }} />}
      {currentCase && !(settings.canReview && ['UNKNOWN', 'REVIEW'].includes(effectiveStatus(result))) && !['RESOLVED', 'SUPERSEDED'].includes(currentCase.status) && (settings.canReview || settings.canDispute) && <form className="crm-decision-form" onSubmit={event => void decide(event)}><h3>Решение по случаю</h3><div className="crm-decision-fields"><label><span className="label">Решение</span><select className="select" value={action} onChange={event => setAction(event.target.value as ControlDecision['action'])}>{(settings.canReview ? ['CONFIRM', 'EXEMPT', 'DISPUTE'] as const : ['DISPUTE'] as const).map(value => <option key={value} value={value}>{decisionNames[value]}</option>)}</select></label><label htmlFor={reasonId}><span className="label">Причина и подтверждение</span><textarea id={reasonId} className="textarea" value={reason} required minLength={5} maxLength={4000} onChange={event => setReason(event.target.value)} placeholder="Укажите причину и где находится подтверждение" /></label></div>{action === 'EXEMPT' && <label><span className="label">Исключение действует до (время вашего устройства)</span><input type="datetime-local" className="field" value={until} required onChange={event => setUntil(event.target.value)} /></label>}<div><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 5 || (action === 'EXEMPT' && (!until || new Date(until).getTime() <= Date.now()))}>{busy ? 'Сохранение…' : 'Сохранить решение'}</button></div>{saved && <p role="status" className="crm-success">{saved}</p>}</form>}
      {!!linkedCase?.decisions.length && <details className="crm-disclosure"><summary>История решений</summary><div className="grid gap-3">{linkedCase.decisions.map(decision => <div key={decision.id}><p>{decisionNames[decision.action]} · {decision.actorName || 'Пользователь платформы'}</p><p>{decision.reason}</p><p className="crm-note">{dateTime(decision.createdAt, tz)}{decision.validUntil ? ` · Действует до ${dateTime(decision.validUntil, tz)}` : ''}</p></div>)}</div></details>}
    </>}
  </section>;
}

function OfferProof({ value, timeZone }: { value: unknown; timeZone: string }) {
  if (!value || typeof value !== 'object') return null;
  const analysis = value as ControlOfferAnalysis;
  if (analysis.version !== 1 || !Array.isArray(analysis.reasons) || !Array.isArray(analysis.candidates)) return null;
  const citations = (items: ControlOfferCitation[]) => items.filter((item, index) =>
    items.findIndex(other => other.quote === item.quote && JSON.stringify(other.locator) === JSON.stringify(item.locator)) === index);
  const location = (locator: ControlOfferCitation['locator']) => locator.kind === 'pdf' ? `Страница ${locator.page}`
    : locator.kind === 'xlsx' ? `Лист «${locator.sheet}», ячейка ${locator.cell}`
      : locator.kind === 'docx' ? 'Текст документа Word' : 'Текст сообщения';
  const quotes = (items: ControlOfferCitation[]) => citations(items).map((item, index) => <div key={index}>
    <p className="crm-note">{location(item.locator)}</p><blockquote className="whitespace-pre-wrap break-words">{item.quote}</blockquote>
  </div>);
  return <details className="crm-disclosure crm-analysis-proof">
    <summary>Разбор КП</summary>
    {!!analysis.reasons.length && <ul className="list-disc pl-5">{analysis.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {!!analysis.evidence?.length && <div className="grid gap-2"><h3>Подтверждения сравнения</h3>{quotes(analysis.evidence)}</div>}
    {!!analysis.candidates.length && <>
      <p className="crm-note">Ниже — найденные фрагменты документов. Они сами по себе не подтверждают, какое КП было отправлено последним.</p>
      {analysis.candidates.map((candidate, index) => <details key={`${candidate.source}:${candidate.sourceId}:${index}`}>
        <summary>Документ {index + 1} · {candidate.source === 'field' ? 'из поля «КП»' : 'отправленное вложение'}</summary>
        <div className="grid gap-2">
          {candidate.sentAt && <p className="crm-note">Отправлено: {dateTime(candidate.sentAt, timeZone)}</p>}
          <p>{candidate.amount ? `Сумма, найденная в файле: ${candidate.amount.decimal} ${candidate.amount.currency}` : 'Однозначный итог в этом файле не подтверждён.'}</p>
          {quotes([...candidate.headingEvidence, ...(candidate.amount?.evidence || [])])}
        </div>
      </details>)}
    </>}
    {!analysis.candidates.length && <p className="crm-note">Нет архивных документов, по которым можно показать разбор.</p>}
  </details>;
}

function DocumentEvidence({ document: source, timeZone }: { document: NonNullable<ControlObservationDetail['documents']>[number]; timeZone: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function download() {
    controller.current?.abort(); controller.current = new AbortController();
    const signal = controller.current.signal;
    setBusy(true); setError('');
    try {
      const response = await fetch(apiUrl(source.downloadUrl), { signal, headers: { Authorization: `Bearer ${getToken()}` } });
      if (!response.ok) throw new Error('Документ недоступен или не прошёл проверку целостности.');
      const file = await response.blob(); // slop-check: allow ai-decor — бинарный архив документа, не декоративный элемент.
      if (signal.aborted) return;
      const url = URL.createObjectURL(file), link = window.document.createElement('a');
      link.href = url; link.download = `crm-document.${file.type === 'application/pdf' ? 'pdf' : 'bin'}`;
      window.document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { if (!signal.aborted) setError(errorText(err, 'Не удалось скачать документ')); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <div><button className="crm-link break-words" type="button" disabled={busy} onClick={() => void download()}>{busy ? 'Загрузка…' : source.label}</button>
    <p className="crm-note">{source.source === 'field' ? 'Поле «КП»' : 'Отправленное вложение'} · {Math.ceil(source.size / 1024)} КБ · Сохранён: {dateTime(source.capturedAt, timeZone)}</p>
    {error && <p role="alert" className="crm-danger">{error}</p>}</div>;
}

type AnalysisProofData = { findings: Array<{ fact: string; label: string; state: string;
  evidence: Array<{ sourceId: string; sourceHash: string; label: string; createdAt: string | null; quote: string; text: string }> }> };
function AnalysisProof({ observationId, resultId, timeZone }: { observationId: string; resultId: string; timeZone: string }) {
  const [data, setData] = useState<AnalysisProofData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true); setError('');
    try { setData(await api<AnalysisProofData>(`${base}/observations/${encodeURIComponent(observationId)}/results/${encodeURIComponent(resultId)}/analysis`)); }
    catch (err) { setError(errorText(err, 'Не удалось загрузить подтверждения анализа')); }
    finally { setLoading(false); }
  };
  return <details className="crm-disclosure crm-analysis-proof" onToggle={event => { if (event.currentTarget.open && !data && !loading && !error) void load(); }}>
    <summary>На чём основан вывод</summary>
    {loading && <p role="status" className="crm-note">Загрузка сохранённых источников…</p>}
    {error && <p role="alert">{error} <button type="button" className="crm-link" onClick={() => void load()}>Повторить</button></p>}
    {data && !data.findings.length && <p className="crm-note">Подтверждения этого анализа сейчас недоступны.</p>}
    {data?.findings.map(finding => <div key={finding.fact} className="grid gap-2"><h3>{finding.label}: {finding.state === 'present' ? 'подтверждено' : finding.state === 'absent' ? 'не найдено' : 'не определено'}</h3>
      {finding.evidence.map((source, index) => <div key={`${source.sourceId}:${index}`}><p className="crm-note">{source.label} · {dateTime(source.createdAt, timeZone)}</p>
        <blockquote className="whitespace-pre-wrap break-words">{source.quote}</blockquote>
        <details><summary>Исходный текст</summary><p className="whitespace-pre-wrap break-words">{source.text}</p></details>
      </div>)}
      {!finding.evidence.length && <p className="crm-note">Признак не найден в проверенном наборе сохранённых источников.</p>}
    </div>)}
  </details>;
}

function ManualReview({ observationId, observedAt, timeZone, result, canReview, onReload, onSaved }: { observationId: string; observedAt: string; timeZone: string; result: ControlResult; canReview: boolean; onReload: () => Promise<void>; onSaved: () => Promise<void> }) {
  const [outcome, setOutcome] = useState<'' | 'PASS' | 'FAIL' | 'NA'>('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const id = useId();
  if (!result.review) return null;
  const canSubmit = Boolean(outcome && reason.trim().length >= 20 && /^https?:\/\/.+/i.test(evidence.trim()));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !result.review) return;
    setBusy(true); setError(''); setConflict(false);
    try {
      await api(`${base}/observations/${encodeURIComponent(observationId)}/results/${encodeURIComponent(result.id)}/review`, { method: 'POST', body: JSON.stringify({ outcome, reason: reason.trim(), evidence: evidence.trim(), expectedDecisionId: result.review.expectedDecisionId }) });
      await onSaved();
    } catch (err) {
      if (err instanceof Error) { try { setConflict(JSON.parse(err.message).statusCode === 409); } catch { /* Network errors have no structured response. */ } }
      setError(errorText(err, 'Не удалось сохранить допроверку'));
    } finally { setBusy(false); }
  }
  return <section className="grid gap-2" aria-label="Ручная допроверка"><h3>Ручная допроверка</h3><p className="crm-note">{result.review.guidance}</p>{canReview && result.review.allowed ? <form className="crm-manual-review" onSubmit={event => void submit(event)}>
    <label><span className="label">Результат ручной проверки</span><select className="select" required value={outcome} onChange={event => setOutcome(event.target.value as typeof outcome)}><option value="">Выберите результат</option><option value="PASS">Требование выполнено</option><option value="FAIL">Нарушение подтверждено</option><option value="NA">Правило неприменимо</option></select></label>
    <label><span className="label">Обоснование результата</span><textarea className="textarea" required minLength={20} maxLength={4000} value={reason} onChange={event => setReason(event.target.value)} aria-describedby={`${id}-reason-help`} /></label><p id={`${id}-reason-help`} className="crm-note">Опишите, что проверили и почему выбрали этот результат. Не менее 20 символов.</p>
    <label><span className="label">Ссылка на подтверждение</span><input className="field" type="url" pattern="https?://.+" required value={evidence} onChange={event => setEvidence(event.target.value)} placeholder="https://" aria-describedby={`${id}-source-help`} /></label><p id={`${id}-source-help`} className="crm-note">Подтверждение должно относиться к состоянию на {dateTime(observedAt, timeZone)}. Укажите ссылку на документ, сообщение или другой источник. Решение сохранится только для этой проверки.</p>
    {error && <p role="alert" className="crm-danger">{error}{conflict ? ' Обновите карточку проверки перед новым решением: другой пользователь уже сохранил результат.' : ''}</p>}
    {conflict && <button className="btn justify-self-start" type="button" disabled={busy} onClick={() => void onReload()}>Обновить карточку проверки</button>}
    <button className="btn btn-primary justify-self-start" type="submit" disabled={busy || conflict || !canSubmit}>{busy ? 'Сохранение…' : 'Сохранить допроверку'}</button>
  </form> : !canReview && <p className="crm-note">Допроверку проводит владелец платформы или руководитель отдела.</p>}</section>;
}

const factLabels: Record<string, string> = {
  deadlineMode: 'Правило срока', maxBusinessDays: 'Рабочих дней', checkDealAge: 'Проверка возраста сделки',
  taskText: 'Текст задачи', maximumDueAt: 'Предельный срок задачи', dueToday: 'Назначена на день проверки', overdue: 'Просрочена', allowedMinimum: 'Минимум задач', allowedMaximum: 'Максимум задач', cutoffLocalTime: 'Граница создания сделки', timeZone: 'Часовой пояс', agePolicy: 'Расчёт возраста',
  taskCount: 'Открытых задач', count: 'Количество', activeTaskCount: 'Открытых задач', taskId: 'Задача', taskTitle: 'Текст задачи', taskTypeId: 'Тип задачи', dueAt: 'Срок задачи', createdAt: 'Создана', createdBefore: 'Создана до', cutoff: 'Граница проверки', cutoffAt: 'Граница проверки', observedAt: 'Время проверки', ageDays: 'Возраст, дней', maxAgeDays: 'Допустимый возраст, дней', ageLimit: 'Допустимый возраст', threshold: 'Порог', thresholdAt: 'Граница возраста', stageEnteredAt: 'Вход на этап', durationHours: 'Время на этапе, ч', elapsedHours: 'Время на этапе, ч', maxDurationHours: 'Допустимое время, ч', allowedTaskTypeIds: 'Допустимые типы задач', noteCount: 'Примечаний', amount: 'Бюджет', source: 'Источник', reason: 'Причина', taskIds: 'Задачи', missing: 'Недостающие данные', limit: 'Ограничение', deadline: 'Предельный срок', taskDeadline: 'Срок задачи', notes: 'Примечания', task: 'Задача', tasks: 'Задачи', noteIds: 'Примечания', completeness: 'Полнота данных', expected: 'Ожидается', actual: 'Зафиксировано', maxHours: 'Предельный срок, ч', ageMode: 'Расчёт возраста', deadlineAt: 'Предельный срок', stageAgeHours: 'На этапе, ч', taskDueAt: 'Срок задачи', actualTypeId: 'Тип задачи', allowedTypeIds: 'Допустимые типы', noteText: 'Текст примечания', boundaryAt: 'Граница возраста', requires: 'Требуется', unsupported: 'Недоступно',
};
function FactValue({ name, value, timeZone }: { name: string; value: unknown; timeZone: string }) {
  if (value === null || value === undefined || typeof value === 'object' && !Array.isArray(value)) return null;
  const label = factLabels[name];
  if (!label) return null;
  const text = Array.isArray(value) ? value.filter(item => typeof item !== 'object').join(', ') : typeof value === 'boolean' ? (value ? 'Да' : 'Нет') : String(value);
  if (!text) return null;
  const display = /^\d{4}-\d{2}-\d{2}T/.test(text) ? dateTime(text, timeZone) : text === 'calendar_month' ? 'Календарный месяц' : text === '30_days' ? '30 дней' : deadlineModeLabels[text as ControlDeadlineMode] || text;
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
  const checksDealAge = draft.scopes.some(scope => scope.checkDealAge !== false);
  const checksCsmAge = draft.scopes.some(scope => scope.department === 'csm' && scope.checkDealAge !== false);
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
    <fieldset className="crm-settings-group">
      <legend>Расписание</legend>
      <div className={`crm-form-grid ${checksDealAge ? 'crm-form-grid-three' : ''}`}>
        <label><span className="label">Время запуска</span><input type="time" className="field" value={draft.timeOfDay} required onChange={event => update({ timeOfDay: event.target.value })} /></label>
        <label><span className="label">Часовой пояс</span><input className="field" value={draft.timeZone} required onChange={event => update({ timeZone: event.target.value })} /><span className="crm-note">Например, Europe/Moscow</span></label>
        {checksDealAge && <label><span className="label">Максимальный возраст сделки</span><select className="select" value={draft.maxDealAge} onChange={event => update({ maxDealAge: event.target.value as ControlConfig['maxDealAge'] })}><option value="calendar_month">Один календарный месяц</option><option value="30_days">30 дней</option></select></label>}
      </div>
      <div className="crm-checks mt-4" role="group" aria-label="Дни проверки">{weekdays.map((day, index) => <label className="crm-check" key={day}><input type="checkbox" checked={draft.workdays.includes(index + 1)} onChange={event => update({ workdays: event.target.checked ? [...draft.workdays, index + 1].sort() : draft.workdays.filter(value => value !== index + 1) })} />{day}</label>)}</div>
      {checksCsmAge && <label className="crm-check mt-4"><input type="checkbox" checked={draft.excludeBaseFromAge} onChange={event => update({ excludeBaseFromAge: event.target.checked })} />Не проверять возраст сделок на этапе «База»</label>}
    </fieldset>
    <fieldset className="crm-settings-group"><legend>Воронки и этапы amoCRM</legend><div className="crm-config-list">{draft.scopes.map((scope, index) => <ScopeEditor key={`${index}:${scope.pipelineId}`} scope={scope} settings={settings} onChange={next => updateScope(index, next)} onRemove={() => update({ scopes: draft.scopes.filter((_, i) => i !== index) })} />)}</div><div className="crm-actions mt-4"><button type="button" className="btn" onClick={() => update({ scopes: [...draft.scopes, { department: 'sales', pipelineId: '', stageRules: {} }] })}>Добавить воронку</button>{!draft.scopes.length && settings.suggestedScopes.length > 0 && <button type="button" className="btn" onClick={() => update({ scopes: structuredClone(settings.suggestedScopes) })}>Подставить найденные воронки</button>}</div>{!settings.options.pipelines.length && <p className="crm-note mt-3">Воронки появятся после подключения и синхронизации amoCRM.</p>}</fieldset>
    <fieldset className="crm-settings-group"><legend>Автоматический запуск</legend><label className="crm-check"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />Проверять по расписанию</label><p className="crm-note mt-2">Для включения выберите воронки. Неуказанные этапы, сроки и типы задач попадут в «Не проверено»; остальные правила выполнятся.</p></fieldset>
    {error && <div role="alert" className="crm-status crm-status-error">{error}</div>}{saved && <p role="status" className="crm-success">Настройки сохранены.</p>}<div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить настройки'}</button></div>
  </form>;
}

function ScopeEditor({ scope, settings, onChange, onRemove }: { scope: ControlScope; settings: ControlSettings; onChange: (scope: ControlScope) => void; onRemove: () => void }) {
  const pipeline = settings.options.pipelines.find(item => item.id === scope.pipelineId);
  const stages = pipeline?.stages.filter(stage => !stage.isWon && !stage.isLost) || [];
  const choices = stages.map(stage => ({ value: stage.id, label: stage.name }));
  const absentStageValue = '__absent';
  const bindingChoices = [{ value: absentStageValue, label: 'Такого этапа нет' }, ...choices];
  const [newStage, setNewStage] = useState('');
  const stageFields: Array<{ key: 'assignedStageId' | 'newClientStageId' | 'baseStageId' | 'preparedProposalStageId' | 'priceRequestedStageId'; label: string }> = scope.department === 'sales'
    ? [{ key: 'assignedStageId', label: 'Назначен ответственный' }, { key: 'preparedProposalStageId', label: 'КП подготовлено' }]
    : [{ key: 'newClientStageId', label: 'Новый клиент' }, { key: 'baseStageId', label: 'База' }, { key: 'preparedProposalStageId', label: 'КП подготовлено' }, { key: 'priceRequestedStageId', label: 'Цена запрошена' }];
  const changeRule = (stageId: string, rule: ControlStageRule) => onChange({ ...scope, stageRules: { ...scope.stageRules, [stageId]: rule } });
  return <section className="crm-stage-rule">
    <div className="crm-config-row"><label><span className="label">Отдел</span><select className="select" value={scope.department} onChange={event => onChange({ department: event.target.value as ControlDepartment, pipelineId: scope.pipelineId, checkDealAge: scope.checkDealAge, stageRules: scope.stageRules })}><option value="sales">ОПНК</option><option value="csm">ОППК</option></select></label><SearchSelect label="Воронка" value={scope.pipelineId} choices={settings.options.pipelines.map(item => ({ value: item.id, label: item.name }))} onChange={pipelineId => onChange({ department: scope.department, pipelineId, checkDealAge: scope.checkDealAge, stageRules: {} })} /><button className="btn btn-ghost" type="button" onClick={onRemove}>Убрать воронку</button></div>
    <label className="crm-check"><input type="checkbox" checked={scope.checkDealAge !== false} onChange={event => onChange({ ...scope, checkDealAge: event.target.checked })} />Проверять возраст сделок в этой воронке</label>
    {scope.checkDealAge === false && <p className="crm-note">Общий возраст сделок не ограничен. Сроки на этапах продолжают проверяться.</p>}
    {!!scope.pipelineId && <><div className="crm-form-grid">{stageFields.map(field => <SearchSelect key={field.key} label={`Этап «${field.label}»`} choices={bindingChoices} value={scope[field.key] === null ? absentStageValue : scope[field.key] || ''} allowEmpty onChange={value => onChange({ ...scope, [field.key]: value === absentStageValue ? null : value || undefined })} />)}</div>
      <details className="crm-disclosure"><summary>Сроки и типы задач по этапам</summary><div className="grid gap-4 mt-3">
        <p className="crm-note">Срок отсчитывается от входа на этап. Проверяется время на этапе и срок следующей задачи; остальные требования задаются отдельно.</p>
        {Object.entries(scope.stageRules || {}).map(([stageId, rule]) => <div className="crm-stage-rule" key={stageId}><div className="crm-section-head"><h3>{stages.find(stage => stage.id === stageId)?.name || 'Этап больше недоступен'}</h3><button type="button" className="crm-link" onClick={() => { const next = { ...scope.stageRules }; delete next[stageId]; onChange({ ...scope, stageRules: next }); }}>Убрать регламент</button></div><StageDeadlineEditor rule={rule} onChange={next => changeRule(stageId, next)} /><TaskTypePicker options={settings.options.taskTypes} selected={rule.allowedTaskTypeIds || []} onChange={allowedTaskTypeIds => changeRule(stageId, { ...rule, allowedTaskTypeIds })} /></div>)}
        <div className="crm-config-row"><SearchSelect label="Этап для регламента" choices={choices.filter(choice => !scope.stageRules?.[choice.value])} value={newStage} onChange={setNewStage} /><button type="button" className="btn" disabled={!newStage} onClick={() => { changeRule(newStage, {}); setNewStage(''); }}>Добавить регламент</button></div>
      </div></details>
    </>}
  </section>;
}

function StageDeadlineEditor({ rule, onChange }: { rule: ControlStageRule; onChange: (rule: ControlStageRule) => void }) {
  const id = useId();
  const mode = rule.deadlineMode || 'elapsed';
  const selectMode = (deadlineMode: ControlDeadlineMode) => {
    const { maxDurationHours, maxBusinessDays, ...shared } = rule;
    onChange({ ...shared, deadlineMode,
      ...(deadlineMode === 'elapsed' && maxDurationHours !== undefined ? { maxDurationHours } : {}),
      ...(deadlineMode === 'business_days' && maxBusinessDays !== undefined ? { maxBusinessDays } : {}),
    });
  };
  return <div className="crm-deadline-editor">
    <div><label className="label" htmlFor={`${id}-mode`}>Ограничение срока</label><select id={`${id}-mode`} className="select" value={mode} onChange={event => selectMode(event.target.value as ControlDeadlineMode)}>{(Object.keys(deadlineModeLabels) as ControlDeadlineMode[]).map(value => <option key={value} value={value}>{deadlineModeLabels[value]}</option>)}</select></div>
    {mode === 'elapsed' && <StageDurationField value={rule.maxDurationHours} required={rule.deadlineMode === 'elapsed'} onChange={maxDurationHours => onChange({ ...rule, maxDurationHours })} />}
    {mode === 'business_days' && <div><label className="label" htmlFor={`${id}-business-days`}>Количество рабочих дней</label><input id={`${id}-business-days`} className="field" type="number" min="1" max="3650" step="1" required value={rule.maxBusinessDays ?? ''} aria-describedby={`${id}-hint`} onChange={event => onChange({ ...rule, maxBusinessDays: event.target.value === '' ? undefined : Number(event.target.value) })} /><p id={`${id}-hint`} className="crm-note mt-2">Суббота и воскресенье не учитываются; праздники автоматически не исключаются. Срок истекает в то же время суток, в которое сделка вошла на этап.</p></div>}
    {mode === 'end_of_day' && <p className="crm-note">Срок истекает в 19:00 в день входа на этап, по часовому поясу расписания проверки.</p>}
    {mode === 'unlimited' && <p className="crm-note">Время на этапе и срок следующей задачи не ограничены. Остальные требования к задачам и настройка возраста воронки не меняются.</p>}
  </div>;
}

const durationHoursPerUnit = { minutes: 1 / 60, hours: 1, days: 24 };
type DurationUnit = keyof typeof durationHoursPerUnit;

function StageDurationField({ value, required = false, onChange }: { value: number | undefined; required?: boolean; onChange: (hours: number | undefined) => void }) {
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
    <div><label className="label" htmlFor={`${id}-value`}>Максимальное время на этапе</label><input id={`${id}-value`} ref={inputRef} className="field" type="number" min="0" step="any" required={required} value={displayValue} onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value) * durationHoursPerUnit[unit])} /></div>
    <div><label className="label" htmlFor={`${id}-unit`}>Единица времени</label><select id={`${id}-unit`} className="select" value={unit} onChange={event => setUnit(event.target.value as DurationUnit)}><option value="minutes">Минуты</option><option value="hours">Часы</option><option value="days">Сутки</option></select></div>
  </div>;
}

function TaskTypePicker({ options, selected, onChange }: { options: Array<{ id: number; name: string }>; selected: number[]; onChange: (ids: number[]) => void }) {
  const [query, setQuery] = useState('');
  const visible = options.filter(option => option.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  const id = useId();
  return <div><label htmlFor={id} className="label">Допустимые типы задачи</label><input id={id} className="field" type="search" placeholder="Поиск типов" value={query} onChange={event => setQuery(event.target.value)} /><div className="crm-checks mt-3">{visible.map(option => <label key={option.id} className="crm-check"><input type="checkbox" checked={selected.includes(option.id)} onChange={event => onChange(event.target.checked ? [...selected, option.id] : selected.filter(value => value !== option.id))} />{option.name}</label>)}</div>{!visible.length && <p className="crm-note mt-2">{options.length ? 'По запросу типов не найдено.' : 'Справочник типов задач недоступен. Выполните синхронизацию amoCRM.'}</p>}</div>;
}
