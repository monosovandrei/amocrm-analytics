'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Database,
  Download,
  Eye,
  EyeOff,
  Filter,
  GripVertical,
  LayoutDashboard,
  LogOut,
  Maximize2,
  Minimize2,
  Pin,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
} from 'lucide-react';
import { api, downloadExcel } from '@/lib/api';
import type {
  BuilderOperator,
  ContractConversionDraft,
  ContractDisplay,
  ContractDurationDraft,
  ContractMeasure,
  ContractMetricDraft,
  ContractMetricPayload,
  ContractMetricType,
  ConversionStep,
  CustomFieldDefinition,
  DashboardLayout,
  DataContractConfig,
  DenominatorType,
  DisplayType,
  FieldOperator,
  FieldOption,
  ForecastSettings,
  Group,
  Manager,
  MetricType,
  Options,
  Pipeline,
  PipelineStage,
  ReportConfig,
  ReportDraft,
  ReportFilters,
  ReportMode,
  ReportTemplate,
  SourceType,
  Tab,
  User,
  UserRole,
  WidgetSize,
} from './report-types';
import {
  buildConditionLabel,
  buildQueryFromTemplate,
  buildReportPayload,
  formatDateTime,
  formatDays,
  formatMetricValue,
  formatMoney,
  formatNumber,
  formatPercent,
  getFieldName,
  getMetric,
  getStageName,
  validateDraft,
} from './report-utils';

const navItems: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'workspace', label: 'Рабочий стол', icon: <LayoutDashboard size={17} /> },
  { id: 'builder', label: 'Конструктор', icon: <SlidersHorizontal size={17} /> },
  { id: 'integration', label: 'amoCRM', icon: <PlugZap size={17} /> },
  { id: 'settings', label: 'Настройки', icon: <Settings size={17} /> },
];

const operatorLabels: Record<BuilderOperator, string> = {
  stage_reached: 'сделка перешла в этап',
  stage_changed: 'сделка перешла из этапа в этап',
  current_stage: 'сделка находится в этапе',
  not_current_stage: 'сделка не находится в этапе',
  field_equals: 'поле сделки равно значению',
  field_filled: 'поле сделки заполнено',
  forecast: 'прогноз по воронке',
};

const metricLabels: Record<MetricType, string> = {
  count: 'Количество',
  total_amount: 'Сумма',
  avg_amount: 'Средний чек',
  conversion: 'Конверсия',
  forecast: 'Прогноз',
  contract: 'Контракт данных',
};

const displayLabels: Record<DisplayType, string> = {
  kpi: 'KPI-виджет',
  funnel: 'Воронка',
  table: 'Таблица',
  forecast: 'Прогноз',
};

const sizeLabels: Record<WidgetSize, string> = {
  sm: '1 колонка',
  md: '2 колонки',
  lg: '4 колонки',
};

function getInitialFilters(): ReportFilters {
  const now = new Date();
  return {
    dateFrom: toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)),
    dateTo: toDateInput(now),
    pipelineIds: [],
    managerIds: [],
    groupIds: [],
  };
}

function toDateInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createContractMetric(label: string, type: ContractMetricType): ContractMetricDraft {
  return {
    id: makeId('metric'),
    label,
    type,
    measure: type === 'conversion' ? 'deal_count' : 'deal_count',
    display: type === 'conversion' ? 'percent' : 'number',
    pipelineId: '',
    fromStageId: '',
    stageIds: [],
    fieldId: '',
    fieldOperator: 'equals',
    fieldValue: '',
    valueFieldId: '',
    fromMetricId: '',
    toMetricId: '',
  };
}

function getDefaultContractMetrics() {
  const metrics = [
    createContractMetric('Лиды получены', 'created_deals'),
    createContractMetric('Обработаны вовремя', 'field_condition'),
    createContractMetric('Квалифицированы', 'stage_reached'),
    createContractMetric('КП отправлены', 'stage_reached'),
    { ...createContractMetric('Сумма счетов', 'stage_reached'), measure: 'field_sum' as ContractMeasure, display: 'money' as ContractDisplay },
    { ...createContractMetric('Сумма оплат', 'stage_reached'), measure: 'field_sum' as ContractMeasure, display: 'money' as ContractDisplay },
  ];
  return [
    ...metrics,
    {
      ...createContractMetric('Лид → квалификация', 'conversion'),
      fromMetricId: metrics[0]?.id ?? '',
      toMetricId: metrics[2]?.id ?? '',
    },
    {
      ...createContractMetric('Квалификация → КП', 'conversion'),
      fromMetricId: metrics[2]?.id ?? '',
      toMetricId: metrics[3]?.id ?? '',
    },
    {
      ...createContractMetric('КП → счёт', 'conversion'),
      fromMetricId: metrics[3]?.id ?? '',
      toMetricId: metrics[4]?.id ?? '',
    },
    {
      ...createContractMetric('Счёт → оплата', 'conversion'),
      fromMetricId: metrics[4]?.id ?? '',
      toMetricId: metrics[5]?.id ?? '',
    },
  ];
}

function getDefaultDraft(): ReportDraft {
  const contractMetrics = getDefaultContractMetrics();
  return {
    mode: 'contract',
    name: 'Рабочий стол РОПа',
    description: 'Контракт данных по менеджерам: лиды, SLA, квалификация, КП, счета, оплаты, конверсии и длительности этапов',
    entity: 'deal',
    operator: 'stage_reached',
    pipelineId: '',
    stageId: '',
    fromStageId: '',
    toStageId: '',
    fieldId: '',
    fieldValue: '',
    metric: 'contract',
    display: 'table',
    denominator: 'previous',
    contractGroupBy: 'manager',
    contractMetrics,
    contractConversions: [],
    contractDurations: [],
    pinned: true,
    size: 'lg',
  };
}

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>('workspace');
  const [options, setOptions] = useState<Options | null>(null);
  const [connection, setConnection] = useState<Record<string, any> | null>(null);
  const [forecastSettings, setForecastSettings] = useState<ForecastSettings | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [filters, setFilters] = useState<ReportFilters>(getInitialFilters);
  const [draft, setDraft] = useState<ReportDraft>(getDefaultDraft);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [message, setMessage] = useState('');
  const [refreshStamp, setRefreshStamp] = useState(0);

  const loadData = useCallback(async () => {
    const [nextOptions, nextConnection, nextForecast, nextTemplates, nextLayout] = await Promise.all([
      api<Options>('/settings/options'),
      api<Record<string, any> | null>('/amo/connection'),
      api<ForecastSettings>('/settings/forecast'),
      api<ReportTemplate[]>('/reports/templates'),
      api<DashboardLayout>('/settings/dashboard-layout').catch(() => ({ config: {} })),
    ]);
    setOptions(nextOptions);
    setConnection(nextConnection);
    setForecastSettings(nextForecast);
    setTemplates(normalizeTemplates(nextTemplates, nextLayout));
  }, []);

  useEffect(() => {
    let mounted = true;
    async function boot() {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        setTokenLoaded(true);
        return;
      }
      try {
        const me = await api<User>('/auth/me');
        if (!mounted) return;
        setUser(me);
        await loadData();
      } catch {
        localStorage.removeItem('accessToken');
        if (mounted) setUser(null);
      } finally {
        if (mounted) setTokenLoaded(true);
      }
    }
    void boot();
    return () => {
      mounted = false;
    };
  }, [loadData]);

  const ordered = useMemo(() => orderTemplates(templates), [templates]);
  const pinned = ordered.filter((item) => item.config.pinned);

  async function handleLogin(nextUser: User) {
    setUser(nextUser);
    await loadData();
  }

  async function saveLayout(nextTemplates: ReportTemplate[]) {
    setTemplates(orderTemplates(nextTemplates));
    await api('/settings/dashboard-layout', {
      method: 'POST',
      body: JSON.stringify({ config: buildLayoutConfig(nextTemplates) }),
    }).catch(() => undefined);
  }

  async function updateTemplateLayout(id: string, patch: Partial<Pick<ReportConfig, 'pinned' | 'order' | 'size'>>) {
    const nextTemplates = templates.map((item) =>
      item.id === id ? { ...item, config: { ...item.config, ...patch } } : item,
    );
    await saveLayout(nextTemplates);
  }

  async function moveTemplate(id: string, direction: -1 | 1) {
    const visible = orderTemplates(templates.filter((item) => item.config.pinned));
    const index = visible.findIndex((item) => item.id === id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= visible.length) return;

    const reordered = [...visible];
    const current = reordered[index];
    const target = reordered[targetIndex];
    reordered[index] = target;
    reordered[targetIndex] = current;

    const orderById = new Map(reordered.map((item, nextIndex) => [item.id, nextIndex + 1]));
    const nextTemplates = templates.map((item) =>
      orderById.has(item.id) ? { ...item, config: { ...item.config, order: orderById.get(item.id) } } : item,
    );
    await saveLayout(nextTemplates);
  }

  function startNewReport() {
    setActiveReportId(null);
    setDraft(applyOptionDefaults(getDefaultDraft(), options));
    setPreview(null);
    setTab('builder');
  }

  function editReport(template: ReportTemplate) {
    setActiveReportId(template.id);
    setDraft(applyOptionDefaults(reportToDraft(template), options));
    setPreview(null);
    setTab('builder');
  }

  async function saveReport(forcePin?: boolean) {
    const nextDraft = forcePin ? { ...draft, pinned: true } : draft;
    const errors = validateDraft(nextDraft);
    if (errors.length) {
      setMessage(errors[0]);
      return;
    }

    const payload = buildReportPayload(nextDraft, filters, templates, activeReportId, options);
    const saved = await api<ReportTemplate>('/reports/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const normalized = normalizeTemplate(saved, {
      reports: {
        [saved.id]: {
          pinned: payload.config.pinned,
          order: payload.config.order,
          size: payload.config.size,
        },
      },
    });
    const nextTemplates = upsertTemplate(templates, normalized);
    setTemplates(orderTemplates(nextTemplates));
    setActiveReportId(saved.id);
    setDraft(reportToDraft(normalized));
    await saveLayout(nextTemplates);
    setMessage(forcePin ? 'Отчёт сохранён и закреплён на рабочем столе' : 'Отчёт сохранён');
    if (forcePin) setTab('workspace');
  }

  async function computePreview() {
    const errors = validateDraft(draft);
    if (errors.length) {
      setMessage(errors[0]);
      return;
    }
    const payload = buildReportPayload(draft, filters, templates, activeReportId, options);
    const result = await api<Record<string, any>>('/reports/compute', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setPreview(result);
    setMessage('Предпросмотр обновлён по текущим данным');
  }

  async function deleteReport(id: string) {
    await api(`/reports/templates/${id}`, { method: 'DELETE' });
    const nextTemplates = templates.filter((item) => item.id !== id);
    await saveLayout(nextTemplates);
    if (activeReportId === id) {
      setActiveReportId(null);
      setDraft(applyOptionDefaults(getDefaultDraft(), options));
      setPreview(null);
    }
    setMessage('Отчёт удалён');
  }

  if (!tokenLoaded) {
    return <main className="content">Загрузка</main>;
  }

  if (!user) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <BarChart3 size={20} />
          </div>
          <div>
            <div className="text-base font-bold">amoCRM Analytics</div>
            <div className="text-xs text-white/60">Рабочий стол РОПа</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
              type="button"
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-profile">
          <div className="flex items-center gap-3">
            <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{user.name}</div>
              <div className="truncate text-xs text-white/55">{user.role === 'ADMIN' ? 'Администратор' : 'РОП'}</div>
            </div>
            <button
              className="icon-btn border-white/15 bg-white/10 text-white hover:bg-white/15 hover:text-white"
              title="Выйти"
              type="button"
              onClick={() => {
                localStorage.removeItem('accessToken');
                setUser(null);
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <div>
            <div className="text-xs font-semibold uppercase text-[var(--pb-text-muted)]">PulseBoard / amoCRM</div>
            <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
              {tab === 'workspace' && 'Рабочий стол'}
              {tab === 'builder' && 'Конструктор отчётов'}
              {tab === 'integration' && 'Интеграция amoCRM'}
              {tab === 'settings' && 'Настройки проекта'}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ${connection?.status === 'ACTIVE' ? 'badge-green' : 'badge-yellow'}`}>
              {connection?.status === 'ACTIVE' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
              {connection?.status === 'ACTIVE' ? 'amoCRM подключена' : 'Нужна интеграция'}
            </span>
            <button className="btn" type="button" onClick={() => setRefreshStamp((value) => value + 1)}>
              <RefreshCw size={15} />
              Обновить
            </button>
          </div>
        </header>

        <section className="content">
          <div className="content-inner">
            {message && (
              <div className="alert">
                <CheckCircle2 className="mt-0.5 text-[var(--pb-accent-green)]" size={17} />
                <span>{message}</span>
              </div>
            )}

            {tab === 'workspace' && (
              <WorkspaceTab
                filters={filters}
                options={options}
                pinnedTemplates={pinned}
                allTemplates={ordered}
                refreshStamp={refreshStamp}
                onCreateReport={startNewReport}
                onEditReport={editReport}
                onMoveTemplate={moveTemplate}
                onSetFilters={setFilters}
                onUpdateLayout={updateTemplateLayout}
              />
            )}

            {tab === 'builder' && (
              <BuilderTab
                activeReportId={activeReportId}
                draft={draft}
                filters={filters}
                options={options}
                preview={preview}
                templates={ordered}
                onComputePreview={computePreview}
                onDeleteReport={deleteReport}
                onEditReport={editReport}
                onNewReport={startNewReport}
                onSaveReport={() => saveReport(false)}
                onSaveAndPin={() => saveReport(true)}
                onSetDraft={setDraft}
                onSetFilters={setFilters}
              />
            )}

            {tab === 'integration' && (
              <IntegrationTab
                connection={connection}
                onMessage={setMessage}
                onReload={loadData}
              />
            )}

            {tab === 'settings' && (
              <SettingsTab
                forecastSettings={forecastSettings}
                options={options}
                onMessage={setMessage}
                onReload={loadData}
              />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const result = await api<{ accessToken: string; user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem('accessToken', result.accessToken);
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--pb-bg)] p-4">
      <form className="card grid w-full max-w-[420px] gap-4 p-6" onSubmit={submit}>
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-[10px] bg-[var(--pb-primary)] text-white">
            <BarChart3 size={20} />
          </div>
          <div>
            <h1 className="m-0 text-xl font-bold">amoCRM Analytics</h1>
            <p className="m-0 text-sm text-[var(--pb-text-secondary)]">Вход в рабочий стол РОПа</p>
          </div>
        </div>
        <label>
          <span className="label">Email</span>
          <input className="field" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
        </label>
        <label>
          <span className="label">Пароль</span>
          <input
            className="field"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="badge badge-red justify-start">{error}</div>}
        <button className="btn btn-primary" type="submit">
          Войти
        </button>
      </form>
    </main>
  );
}

function WorkspaceTab({
  allTemplates,
  filters,
  options,
  pinnedTemplates,
  refreshStamp,
  onCreateReport,
  onEditReport,
  onMoveTemplate,
  onSetFilters,
  onUpdateLayout,
}: {
  allTemplates: ReportTemplate[];
  filters: ReportFilters;
  options: Options | null;
  pinnedTemplates: ReportTemplate[];
  refreshStamp: number;
  onCreateReport: () => void;
  onEditReport: (template: ReportTemplate) => void;
  onMoveTemplate: (id: string, direction: -1 | 1) => void;
  onSetFilters: (filters: ReportFilters) => void;
  onUpdateLayout: (id: string, patch: Partial<Pick<ReportConfig, 'pinned' | 'order' | 'size'>>) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">Рабочий стол РОПа</h1>
          <p className="page-description">
            Закреплённые отчёты пересчитываются по данным amoCRM и обновляются автоматически.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={() => setSettingsOpen((value) => !value)}>
            <GripVertical size={15} />
            Настроить рабочий стол
          </button>
          <button className="btn btn-primary" type="button" onClick={onCreateReport}>
            <Plus size={15} />
            Создать отчёт
          </button>
        </div>
      </div>

      <WorkspaceFilters filters={filters} options={options} onSetFilters={onSetFilters} />

      {settingsOpen && (
        <DashboardSettings
          templates={allTemplates}
          onEditReport={onEditReport}
          onMoveTemplate={onMoveTemplate}
          onUpdateLayout={onUpdateLayout}
        />
      )}

      {pinnedTemplates.length === 0 ? (
        <div className="empty-state">
          <div>
            <div className="mx-auto grid h-11 w-11 place-items-center rounded-[10px] bg-white text-[var(--pb-primary)] shadow-sm">
              <LayoutDashboard size={22} />
            </div>
            <h2 className="mt-4 text-lg font-bold">На рабочем столе пока нет закреплённых отчётов</h2>
            <p className="mt-2 max-w-[560px] text-sm text-[var(--pb-text-secondary)]">
              Создайте отчёт в конструкторе, задайте условие amoCRM и закрепите его как виджет.
            </p>
            <button className="btn btn-primary mt-4" type="button" onClick={onCreateReport}>
              <Plus size={15} />
              Создать первый отчёт
            </button>
          </div>
        </div>
      ) : (
        <div className="dashboard-grid">
          {pinnedTemplates.map((template) => (
            <ReportWidget
              key={`${template.id}-${refreshStamp}`}
              filters={filters}
              onEdit={() => onEditReport(template)}
              onMoveDown={() => onMoveTemplate(template.id, 1)}
              onMoveUp={() => onMoveTemplate(template.id, -1)}
              onResize={(size) => onUpdateLayout(template.id, { size })}
              onUnpin={() => onUpdateLayout(template.id, { pinned: false })}
              template={template}
            />
          ))}
        </div>
      )}
    </>
  );
}

function WorkspaceFilters({
  filters,
  options,
  onSetFilters,
}: {
  filters: ReportFilters;
  options: Options | null;
  onSetFilters: (filters: ReportFilters) => void;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Фильтр рабочего стола</div>
        <span className="badge">
          <CalendarDays size={14} />
          Период применяется ко всем виджетам
        </span>
      </div>
      <div className="card-body">
        <div className="toolbar">
          <label>
            <span className="label">Дата с</span>
            <input
              className="field"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={(event) => onSetFilters({ ...filters, dateFrom: event.target.value })}
            />
          </label>
          <label>
            <span className="label">Дата по</span>
            <input
              className="field"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={(event) => onSetFilters({ ...filters, dateTo: event.target.value })}
            />
          </label>
          <MultiCheckbox
            label="Воронки"
            values={filters.pipelineIds ?? []}
            options={(options?.pipelines ?? []).map((item) => ({ value: item.id, label: item.name }))}
            onChange={(pipelineIds) => onSetFilters({ ...filters, pipelineIds })}
          />
          <MultiCheckbox
            label="Менеджеры"
            values={filters.managerIds ?? []}
            options={(options?.managers ?? [])
              .filter((item) => item.isVisible)
              .map((item) => ({ value: item.id, label: item.name }))}
            onChange={(managerIds) => onSetFilters({ ...filters, managerIds })}
          />
          <MultiCheckbox
            label="Группы"
            values={filters.groupIds ?? []}
            options={(options?.groups ?? [])
              .filter((item) => item.isVisible)
              .map((item) => ({ value: item.id, label: item.name }))}
            onChange={(groupIds) => onSetFilters({ ...filters, groupIds })}
          />
          <div className="grid content-end">
            <button className="btn" type="button" onClick={() => onSetFilters(getInitialFilters())}>
              Сбросить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardSettings({
  templates,
  onEditReport,
  onMoveTemplate,
  onUpdateLayout,
}: {
  templates: ReportTemplate[];
  onEditReport: (template: ReportTemplate) => void;
  onMoveTemplate: (id: string, direction: -1 | 1) => void;
  onUpdateLayout: (id: string, patch: Partial<Pick<ReportConfig, 'pinned' | 'order' | 'size'>>) => void;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Настройка рабочего стола</div>
          <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
            Управляйте отображением, порядком и шириной каждого созданного отчёта.
          </div>
        </div>
      </div>
      <div className="card-body grid gap-3">
        {templates.length === 0 && <div className="muted text-sm">Сначала создайте отчёт в конструкторе.</div>}
        {templates.map((template) => (
          <div key={template.id} className="grid gap-3 rounded-[10px] border border-[var(--pb-border)] p-3 md:grid-cols-[1fr_150px_150px_160px] md:items-center">
            <label className="flex items-center gap-3">
              <input
                checked={Boolean(template.config.pinned)}
                type="checkbox"
                onChange={(event) => onUpdateLayout(template.id, { pinned: event.target.checked })}
              />
              <span>
                <span className="block font-semibold">{template.name}</span>
                <span className="block text-xs text-[var(--pb-text-secondary)]">{template.config.conditionLabel}</span>
              </span>
            </label>
            <select
              className="select"
              value={template.config.size ?? 'md'}
              onChange={(event) => onUpdateLayout(template.id, { size: event.target.value as WidgetSize })}
            >
              <option value="sm">{sizeLabels.sm}</option>
              <option value="md">{sizeLabels.md}</option>
              <option value="lg">{sizeLabels.lg}</option>
            </select>
            <div className="flex gap-2">
              <button className="icon-btn" title="Выше" type="button" onClick={() => onMoveTemplate(template.id, -1)}>
                <ArrowUp size={15} />
              </button>
              <button className="icon-btn" title="Ниже" type="button" onClick={() => onMoveTemplate(template.id, 1)}>
                <ArrowDown size={15} />
              </button>
            </div>
            <button className="btn" type="button" onClick={() => onEditReport(template)}>
              <SlidersHorizontal size={15} />
              Открыть в конструкторе
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportWidget({
  filters,
  onEdit,
  onMoveDown,
  onMoveUp,
  onResize,
  onUnpin,
  template,
}: {
  filters: ReportFilters;
  onEdit: () => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onResize: (size: WidgetSize) => void;
  onUnpin: () => void;
  template: ReportTemplate;
}) {
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const query = useMemo(() => buildQueryFromTemplate(template, filters), [template, filters]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const next = await api<Record<string, any>>('/reports/compute', {
          method: 'POST',
          body: JSON.stringify(query),
        });
        if (!cancelled) setResult(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось посчитать отчёт');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [query]);

  const metric = getMetric(template, result);
  const size = template.config.size ?? 'md';

  return (
    <article className={`card card-hover widget-${size}`} data-testid={`widget-${template.id}`}>
      <div className="card-header">
        <div className="min-w-0">
          <div className="card-title truncate">{template.name}</div>
          <div className="mt-1 truncate text-xs text-[var(--pb-text-secondary)]">{template.config.conditionLabel}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button className="icon-btn" title="Выше" type="button" onClick={onMoveUp}>
            <ArrowUp size={14} />
          </button>
          <button className="icon-btn" title="Ниже" type="button" onClick={onMoveDown}>
            <ArrowDown size={14} />
          </button>
          <button className="icon-btn" title="Настроить" type="button" onClick={onEdit}>
            <SlidersHorizontal size={14} />
          </button>
          <button className="icon-btn" title="Скрыть" type="button" onClick={onUnpin}>
            <EyeOff size={14} />
          </button>
        </div>
      </div>
      <div className="card-body grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="badge badge-blue">
            <Activity size={14} />
            Автообновление 60 сек
          </span>
          <select className="select max-w-[150px]" value={size} onChange={(event) => onResize(event.target.value as WidgetSize)}>
            <option value="sm">{sizeLabels.sm}</option>
            <option value="md">{sizeLabels.md}</option>
            <option value="lg">{sizeLabels.lg}</option>
          </select>
        </div>

        {loading && <div className="muted text-sm">Считаю по данным amoCRM...</div>}
        {error && <div className="badge badge-red justify-start">{error}</div>}
        {!loading && !error && (
          <>
            <div>
              <div className="metric-value mono-num">{metric.value}</div>
              <div className="metric-caption">{metric.caption}</div>
            </div>
            <ReportResultDetails result={result} template={template} />
          </>
        )}
      </div>
    </article>
  );
}

function BuilderTab({
  activeReportId,
  draft,
  filters,
  options,
  preview,
  templates,
  onComputePreview,
  onDeleteReport,
  onEditReport,
  onNewReport,
  onSaveAndPin,
  onSaveReport,
  onSetDraft,
  onSetFilters,
}: {
  activeReportId: string | null;
  draft: ReportDraft;
  filters: ReportFilters;
  options: Options | null;
  preview: Record<string, any> | null;
  templates: ReportTemplate[];
  onComputePreview: () => void;
  onDeleteReport: (id: string) => void;
  onEditReport: (template: ReportTemplate) => void;
  onNewReport: () => void;
  onSaveAndPin: () => void;
  onSaveReport: () => void;
  onSetDraft: (draft: ReportDraft) => void;
  onSetFilters: (filters: ReportFilters) => void;
}) {
  const errors = validateDraft(draft);

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">Конструктор отчётов</h1>
          <p className="page-description">
            Соберите правило из amoCRM: объект, действие, этапы, поля, фильтры и формат отображения.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={onComputePreview}>
            <RefreshCw size={15} />
            Предпросмотр
          </button>
          <button className="btn" type="button" onClick={onSaveReport} disabled={errors.length > 0}>
            <Save size={15} />
            Сохранить
          </button>
          <button className="btn btn-primary" type="button" onClick={onSaveAndPin} disabled={errors.length > 0}>
            <Pin size={15} />
            Сохранить и закрепить
          </button>
        </div>
      </div>

      <div className="builder-layout">
        <aside className="card">
          <div className="card-header">
            <div className="card-title">Созданные отчёты</div>
            <button className="icon-btn" title="Новый отчёт" type="button" onClick={onNewReport}>
              <Plus size={15} />
            </button>
          </div>
          <div className="card-body report-list">
            {templates.length === 0 && <div className="muted text-sm">Сохранённых отчётов пока нет.</div>}
            {templates.map((template) => (
              <button
                key={template.id}
                className={`report-list-item ${activeReportId === template.id ? 'active' : ''}`}
                type="button"
                onClick={() => onEditReport(template)}
              >
                <span className="truncate font-semibold">{template.name}</span>
                <span className="truncate text-xs text-[var(--pb-text-secondary)]">{template.config.conditionLabel}</span>
                <span className="flex gap-2">
                  <span className={`badge ${template.config.pinned ? 'badge-green' : ''}`}>
                    {template.config.pinned ? <Eye size={13} /> : <EyeOff size={13} />}
                    {template.config.pinned ? 'на рабочем столе' : 'скрыт'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Правило отчёта</div>
              <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                Пример: сделки, которые перешли в этап “КП презентовано”.
              </div>
            </div>
          </div>
          <div className="card-body grid gap-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label>
                <span className="label">Тип отчёта</span>
                <select
                  className="select"
                  value={draft.mode}
                  onChange={(event) => {
                    const mode = event.target.value as ReportMode;
                    onSetDraft({
                      ...draft,
                      mode,
                      metric: mode === 'contract' ? 'contract' : draft.metric === 'contract' ? 'count' : draft.metric,
                      display: mode === 'contract' ? 'table' : draft.display,
                      size: mode === 'contract' ? 'lg' : draft.size,
                    });
                  }}
                >
                  <option value="contract">Контракт данных: много показателей в одном отчёте</option>
                  <option value="single">Один показатель / простой KPI</option>
                </select>
              </label>
              <label>
                <span className="label">Название отчёта</span>
                <input
                  className="field"
                  value={draft.name}
                  onChange={(event) => onSetDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label>
                <span className="label">Размер виджета</span>
                <select
                  className="select"
                  value={draft.size}
                  onChange={(event) => onSetDraft({ ...draft, size: event.target.value as WidgetSize })}
                >
                  <option value="sm">{sizeLabels.sm}</option>
                  <option value="md">{sizeLabels.md}</option>
                  <option value="lg">{sizeLabels.lg}</option>
                </select>
              </label>
              <label className="md:col-span-2">
                <span className="label">Описание</span>
                <textarea
                  className="textarea"
                  value={draft.description}
                  onChange={(event) => onSetDraft({ ...draft, description: event.target.value })}
                />
              </label>
            </div>

            {draft.mode === 'contract' ? (
              <ContractBuilder draft={draft} onSetDraft={onSetDraft} options={options} />
            ) : (
              <>
                <RuleBuilder draft={draft} onSetDraft={onSetDraft} options={options} />

                <div className="grid gap-4 md:grid-cols-3">
                  <label>
                    <span className="label">Показатель</span>
                    <select
                      className="select"
                      value={draft.metric}
                      onChange={(event) => onSetDraft({ ...draft, metric: event.target.value as MetricType })}
                    >
                      <option value="count">{metricLabels.count}</option>
                      <option value="total_amount">{metricLabels.total_amount}</option>
                      <option value="avg_amount">{metricLabels.avg_amount}</option>
                      <option value="conversion">{metricLabels.conversion}</option>
                      <option value="forecast">{metricLabels.forecast}</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Формат отображения</span>
                    <select
                      className="select"
                      value={draft.display}
                      onChange={(event) => onSetDraft({ ...draft, display: event.target.value as DisplayType })}
                    >
                      <option value="kpi">{displayLabels.kpi}</option>
                      <option value="funnel">{displayLabels.funnel}</option>
                      <option value="table">{displayLabels.table}</option>
                      <option value="forecast">{displayLabels.forecast}</option>
                    </select>
                  </label>
                  <label>
                    <span className="label">Конверсия считать от</span>
                    <select
                      className="select"
                      value={draft.denominator}
                      onChange={(event) => onSetDraft({ ...draft, denominator: event.target.value as DenominatorType })}
                    >
                      <option value="previous">предыдущего шага</option>
                      <option value="first">первого шага</option>
                    </select>
                  </label>
                </div>
              </>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <label>
                <span className="label">Дата с</span>
                <input
                  className="field"
                  type="date"
                  value={filters.dateFrom ?? ''}
                  onChange={(event) => onSetFilters({ ...filters, dateFrom: event.target.value })}
                />
              </label>
              <label>
                <span className="label">Дата по</span>
                <input
                  className="field"
                  type="date"
                  value={filters.dateTo ?? ''}
                  onChange={(event) => onSetFilters({ ...filters, dateTo: event.target.value })}
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <MultiCheckbox
                label="Менеджеры для отчёта"
                values={filters.managerIds ?? []}
                options={(options?.managers ?? [])
                  .filter((item) => item.isVisible)
                  .map((item) => ({ value: item.id, label: item.name }))}
                onChange={(managerIds) => onSetFilters({ ...filters, managerIds })}
              />
              <MultiCheckbox
                label="Группы для отчёта"
                values={filters.groupIds ?? []}
                options={(options?.groups ?? [])
                  .filter((item) => item.isVisible)
                  .map((item) => ({ value: item.id, label: item.name }))}
                onChange={(groupIds) => onSetFilters({ ...filters, groupIds })}
              />
            </div>

            <label className="flex items-center gap-3 text-sm font-semibold">
              <input
                checked={draft.pinned}
                type="checkbox"
                onChange={(event) => onSetDraft({ ...draft, pinned: event.target.checked })}
              />
              Закрепить на рабочем столе после сохранения
            </label>

            {errors.length > 0 && (
              <div className="badge badge-yellow justify-start">
                <AlertCircle size={14} />
                {errors[0]}
              </div>
            )}
          </div>
        </section>

        <aside className="card">
          <div className="card-header">
            <div className="card-title">Предпросмотр</div>
            {activeReportId && (
              <button className="icon-btn" title="Удалить отчёт" type="button" onClick={() => onDeleteReport(activeReportId)}>
                <Trash2 size={15} />
              </button>
            )}
          </div>
          <div className="card-body grid gap-4">
            <div className="condition-strip">
              <span className="badge badge-blue">Сделка</span>
              <span className="text-sm text-[var(--pb-text-secondary)]">{buildConditionLabel(draft, options)}</span>
            </div>
            {preview ? (
              <>
                <div>
                  <div className="metric-value mono-num">{getMetric({ name: draft.name, config: { metric: draft.metric, display: draft.display } }, preview).value}</div>
                  <div className="metric-caption">Расчёт по текущему правилу</div>
                </div>
                <ReportResultDetails
                  result={preview}
                  template={{ id: 'preview', name: draft.name, sourceType: 'EVENT', config: { metric: draft.metric, display: draft.display } }}
                />
              </>
            ) : (
              <div className="empty-state min-h-[180px]">
                <div>
                  <BarChart3 className="mx-auto text-[var(--pb-primary)]" size={28} />
                  <div className="mt-3 text-sm font-semibold">Нажмите “Предпросмотр”</div>
                  <div className="mt-1 text-xs text-[var(--pb-text-secondary)]">Отчёт будет посчитан на реальных данных.</div>
                </div>
              </div>
            )}
            <button
              className="btn"
              type="button"
              onClick={() => {
                const payload = buildReportPayload(draft, filters, templates, activeReportId, options);
                void downloadExcel('/reports/export.xlsx', payload);
              }}
              disabled={errors.length > 0}
            >
              <Download size={15} />
              Скачать Excel
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

function ContractBuilder({
  draft,
  onSetDraft,
  options,
}: {
  draft: ReportDraft;
  onSetDraft: (draft: ReportDraft) => void;
  options: Options | null;
}) {
  const dealFields = (options?.customFields ?? []).filter((field) => field.entityType === 'LEAD');
  const allStages = (options?.pipelines ?? []).flatMap((pipeline) =>
    pipeline.stages.map((stage) => ({ value: stage.id, label: `${pipeline.name} / ${stage.name}` })),
  );
  const dealFieldOptions = dealFields.map((field) => ({
    value: field.externalId,
    label: field.name,
    description: 'Поле сделки amoCRM',
  }));
  const calculationFieldOptions = [
    { value: '', label: 'Бюджет сделки', description: 'Системное поле сделки' },
    ...dealFieldOptions,
  ];
  const sourceMetrics = draft.contractMetrics.filter((metric) => metric.type !== 'conversion');

  function patchMetric(id: string, patch: Partial<ContractMetricDraft>) {
    onSetDraft({
      ...draft,
      contractMetrics: draft.contractMetrics.map((metric) =>
        metric.id === id ? { ...metric, ...patch } : metric,
      ),
    });
  }

  function removeMetric(id: string) {
    onSetDraft({
      ...draft,
      contractMetrics: draft.contractMetrics.filter((metric) => metric.id !== id),
      contractConversions: draft.contractConversions.filter(
        (conversion) => conversion.fromMetricId !== id && conversion.toMetricId !== id,
      ),
    });
  }

  function patchConversion(id: string, patch: Partial<ContractConversionDraft>) {
    onSetDraft({
      ...draft,
      contractConversions: draft.contractConversions.map((conversion) =>
        conversion.id === id ? { ...conversion, ...patch } : conversion,
      ),
    });
  }

  function patchDuration(id: string, patch: Partial<ContractDurationDraft>) {
    onSetDraft({
      ...draft,
      contractDurations: draft.contractDurations.map((duration) =>
        duration.id === id ? { ...duration, ...patch } : duration,
      ),
    });
  }

  return (
    <div className="grid gap-5">
      <div className="condition-strip">
        <Filter size={16} className="text-[var(--pb-primary)]" />
        <span className="text-sm font-semibold">Контракт данных</span>
        <span className="text-sm text-[var(--pb-text-secondary)]">
          В одном отчёте: любые показатели, допустимые операции, конверсии и среднее время по этапам.
        </span>
      </div>

      <label className="max-w-[360px]">
        <span className="label">Срез отчёта</span>
        <select
          className="select"
          value={draft.contractGroupBy}
          onChange={(event) => onSetDraft({ ...draft, contractGroupBy: event.target.value as 'manager' | 'none' })}
        >
          <option value="manager">По отделу и менеджерам</option>
          <option value="none">Только весь отдел</option>
        </select>
      </label>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="card-title">Показатели отчёта</div>
            <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
              Каждый показатель сам задаёт выборку данных, операцию расчёта и допустимый формат вывода.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn"
              type="button"
              onClick={() =>
                onSetDraft({
                  ...draft,
                  contractMetrics: [...draft.contractMetrics, createContractMetric('Новый показатель', 'stage_reached')],
                })
              }
            >
              <Plus size={15} />
              Добавить показатель
            </button>
            <button
              className="btn"
              type="button"
              onClick={() =>
                onSetDraft({
                  ...draft,
                  contractMetrics: [
                    ...draft.contractMetrics,
                    {
                      ...createContractMetric('Новая конверсия', 'conversion'),
                      fromMetricId: sourceMetrics[0]?.id ?? '',
                      toMetricId: sourceMetrics[1]?.id ?? '',
                    },
                  ],
                })
              }
            >
              <Plus size={15} />
              Добавить конверсию
            </button>
          </div>
        </div>

        {draft.contractMetrics.map((metric, index) => (
          <div key={metric.id} className="grid gap-4 rounded-[12px] border border-[var(--pb-border)] bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="badge badge-blue">#{index + 1}</span>
              <button className="btn btn-danger" type="button" onClick={() => removeMetric(metric.id)}>
                <Trash2 size={14} />
                Удалить
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label>
                <span className="label">Название колонки</span>
                <input
                  className="field"
                  value={metric.label}
                  onChange={(event) => patchMetric(metric.id, { label: event.target.value })}
                />
              </label>
              <label>
                <span className="label">Что считать</span>
                <select
                  className="select"
                  value={metric.type}
                  onChange={(event) => {
                    const type = event.target.value as ContractMetricType;
                    patchMetric(metric.id, {
                      type,
                      measure: type === 'conversion' ? 'deal_count' : metric.measure,
                      display: type === 'conversion' ? 'percent' : metric.display === 'percent' ? 'number' : metric.display,
                    });
                  }}
                >
                  <option value="created_deals">Лиды/сделки, полученные за период</option>
                  <option value="field_condition">Сделки, где поле соответствует условию</option>
                  <option value="stage_reached">Сделки, перешедшие в выбранные этапы</option>
                  <option value="current_stage">Сделки, которые сейчас находятся в этапах</option>
                  <option value="conversion">Конверсию между показателями</option>
                </select>
              </label>
            </div>

            {metric.type === 'conversion' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <label>
                  <span className="label">Откуда</span>
                  <select
                    className="select"
                    value={metric.fromMetricId}
                    onChange={(event) => patchMetric(metric.id, { fromMetricId: event.target.value })}
                  >
                    <option value="">Выберите показатель</option>
                    {sourceMetrics.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="label">Куда</span>
                  <select
                    className="select"
                    value={metric.toMetricId}
                    onChange={(event) => patchMetric(metric.id, { toMetricId: event.target.value })}
                  >
                    <option value="">Выберите показатель</option>
                    {sourceMetrics.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="badge badge-blue justify-start md:col-span-2">
                  Конверсия всегда отображается в процентах. Деление обычных показателей недоступно.
                </div>
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <label>
                    <span className="label">Операция</span>
                    <select
                      className="select"
                      value={metric.measure}
                      onChange={(event) => {
                        const measure = event.target.value as ContractMeasure;
                        patchMetric(metric.id, {
                          measure,
                          display: measure === 'deal_count' ? 'number' : metric.display === 'percent' ? 'money' : metric.display,
                        });
                      }}
                    >
                      <option value="deal_count">Количество сделок</option>
                      <option value="field_sum">Сумма по полю</option>
                      <option value="field_avg">Среднее по полю</option>
                    </select>
                  </label>
                  {metric.measure !== 'deal_count' && (
                    <FieldCombobox
                      label="Поле для расчёта"
                      value={metric.valueFieldId}
                      options={calculationFieldOptions}
                      onChange={(value) => patchMetric(metric.id, { valueFieldId: value })}
                      placeholder="Выберите поле для расчёта"
                    />
                  )}
                  <label>
                    <span className="label">Что отображать</span>
                    <select
                      className="select"
                      value={metric.display}
                      onChange={(event) => patchMetric(metric.id, { display: event.target.value as ContractDisplay })}
                    >
                      <option value="number" disabled={metric.measure !== 'deal_count'}>
                        Число
                      </option>
                      <option value="money" disabled={metric.measure === 'deal_count'}>
                        Деньги
                      </option>
                    </select>
                  </label>
                </div>

                {(metric.type === 'stage_reached' || metric.type === 'current_stage') && (
                  allStages.length > 0 ? (
                    <>
                      {metric.type === 'stage_reached' && (
                        <label>
                          <span className="label">Откуда</span>
                          <select
                            className="select"
                            value={metric.fromStageId}
                            onChange={(event) => patchMetric(metric.id, { fromStageId: event.target.value })}
                          >
                            <option value="">Неважно</option>
                            {allStages.map((stage) => (
                              <option key={stage.value} value={stage.value}>
                                {stage.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <MultiCheckbox
                        label={metric.type === 'stage_reached' ? 'Куда' : 'В каких этапах'}
                        values={metric.stageIds}
                        options={allStages}
                        onChange={(stageIds) => patchMetric(metric.id, { stageIds })}
                      />
                    </>
                  ) : (
                    <div className="badge badge-blue justify-start">
                      Этапы появятся после синхронизации amoCRM. Лишние поля выбора скрыты.
                    </div>
                  )
                )}

                {metric.type === 'field_condition' && (
                  <div className="grid gap-4 md:grid-cols-[1fr_160px_1fr]">
                    <FieldCombobox
                      label="Поле amoCRM"
                      value={metric.fieldId}
                      options={dealFieldOptions}
                      onChange={(value) => patchMetric(metric.id, { fieldId: value })}
                      placeholder="Выберите поле"
                      emptyText="Поля появятся после синхронизации amoCRM"
                    />
                    <label>
                      <span className="label">Условие</span>
                      <select
                        className="select"
                        value={metric.fieldOperator}
                        onChange={(event) => patchMetric(metric.id, { fieldOperator: event.target.value as FieldOperator })}
                      >
                        <option value="equals">равно</option>
                        <option value="contains">содержит</option>
                        <option value="is_set">заполнено</option>
                        <option value="lt">&lt;</option>
                        <option value="lte">&lt;=</option>
                        <option value="gt">&gt;</option>
                        <option value="gte">&gt;=</option>
                      </select>
                    </label>
                    <label>
                      <span className="label">Значение</span>
                      <input
                        className="field"
                        disabled={metric.fieldOperator === 'is_set'}
                        value={metric.fieldValue}
                        onChange={(event) => patchMetric(metric.id, { fieldValue: event.target.value })}
                        placeholder="Например: 20"
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="card-title">Среднее время в этапах</div>
            <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
              Добавьте этапы, по которым нужно считать среднее время нахождения сделки.
            </div>
          </div>
          <button
            className="btn"
            type="button"
            onClick={() =>
              onSetDraft({
                ...draft,
                contractDurations: [
                  ...draft.contractDurations,
                  { id: makeId('duration'), label: 'Время в этапе', stageId: allStages[0]?.value ?? '' },
                ],
              })
            }
          >
            <Plus size={15} />
            Добавить этап
          </button>
        </div>

        {draft.contractDurations.map((duration) => (
          <div key={duration.id} className="grid gap-3 rounded-[10px] border border-[var(--pb-border)] bg-white p-3 md:grid-cols-[1fr_1fr_42px]">
            <input
              className="field"
              value={duration.label}
              onChange={(event) => patchDuration(duration.id, { label: event.target.value })}
            />
            <select className="select" value={duration.stageId} onChange={(event) => patchDuration(duration.id, { stageId: event.target.value })}>
              <option value="">Выберите этап</option>
              {allStages.map((stage) => (
                <option key={stage.value} value={stage.value}>
                  {stage.label}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              title="Удалить этап"
              type="button"
              onClick={() =>
                onSetDraft({
                  ...draft,
                  contractDurations: draft.contractDurations.filter((item) => item.id !== duration.id),
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

function RuleBuilder({
  draft,
  onSetDraft,
  options,
}: {
  draft: ReportDraft;
  onSetDraft: (draft: ReportDraft) => void;
  options: Options | null;
}) {
  const selectedPipeline = options?.pipelines.find((item) => item.id === draft.pipelineId) ?? options?.pipelines[0];
  const stages = selectedPipeline?.stages ?? [];
  const dealFields = (options?.customFields ?? []).filter((field) => field.entityType === 'LEAD');

  function patch(next: Partial<ReportDraft>) {
    onSetDraft({ ...draft, ...next });
  }

  return (
    <div className="rule-chain">
      <div className="condition-strip">
        <Filter size={16} className="text-[var(--pb-primary)]" />
        <span className="text-sm font-semibold">Добавить элемент</span>
        <span className="text-sm text-[var(--pb-text-secondary)]">{buildConditionLabel(draft, options)}</span>
      </div>

      <div className="rule-row">
        <span className="label m-0">Объект</span>
        <select className="select" value={draft.entity} onChange={() => patch({ entity: 'deal' })}>
          <option value="deal">Сделка amoCRM</option>
          <option value="contact" disabled>
            Контакт amoCRM
          </option>
          <option value="task" disabled>
            Задача amoCRM
          </option>
        </select>
      </div>

      <div className="rule-row">
        <span className="label m-0">Что учитывать</span>
        <select
          className="select"
          value={draft.operator}
          onChange={(event) => {
            const operator = event.target.value as BuilderOperator;
            patch({
              operator,
              display: operator === 'forecast' ? 'forecast' : draft.display,
              metric: operator === 'forecast' ? 'forecast' : draft.metric === 'forecast' ? 'count' : draft.metric,
            });
          }}
        >
          <option value="stage_reached">{operatorLabels.stage_reached}</option>
          <option value="stage_changed">{operatorLabels.stage_changed}</option>
          <option value="current_stage">{operatorLabels.current_stage}</option>
          <option value="not_current_stage">{operatorLabels.not_current_stage}</option>
          <option value="field_equals">{operatorLabels.field_equals}</option>
          <option value="field_filled">{operatorLabels.field_filled}</option>
          <option value="forecast">{operatorLabels.forecast}</option>
        </select>
      </div>

      {draft.operator !== 'field_equals' && draft.operator !== 'field_filled' && (
        <div className="rule-row">
          <span className="label m-0">Воронка</span>
          <select
            className="select"
            value={draft.pipelineId || selectedPipeline?.id || ''}
            onChange={(event) =>
              patch({
                pipelineId: event.target.value,
                stageId: '',
                fromStageId: '',
                toStageId: '',
              })
            }
          >
            <option value="">Все воронки</option>
            {(options?.pipelines ?? []).map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {(draft.operator === 'stage_reached' ||
        draft.operator === 'current_stage' ||
        draft.operator === 'not_current_stage') && (
        <div className="rule-row">
          <span className="label m-0">{draft.operator === 'stage_reached' ? 'В этап' : 'Этап'}</span>
          <select
            className="select"
            value={draft.stageId}
            onChange={(event) => patch({ stageId: event.target.value })}
          >
            <option value="">Выберите этап</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {draft.operator === 'stage_changed' && (
        <>
          <div className="rule-row">
            <span className="label m-0">Из этапа</span>
            <select
              className="select"
              value={draft.fromStageId}
              onChange={(event) => patch({ fromStageId: event.target.value })}
            >
              <option value="">Любой предыдущий этап</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </div>
          <div className="rule-row">
            <span className="label m-0">В этап</span>
            <select
              className="select"
              value={draft.toStageId}
              onChange={(event) => patch({ toStageId: event.target.value })}
            >
              <option value="">Выберите этап</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {(draft.operator === 'field_equals' || draft.operator === 'field_filled') && (
        <>
          <div className="rule-row">
            <span className="label m-0">Поле сделки</span>
            <select className="select" value={draft.fieldId} onChange={(event) => patch({ fieldId: event.target.value })}>
              <option value="">Выберите поле amoCRM</option>
              {dealFields.map((field) => (
                <option key={field.id} value={field.externalId}>
                  {field.name}
                </option>
              ))}
            </select>
          </div>
          {draft.operator === 'field_equals' && (
            <div className="rule-row">
              <span className="label m-0">Значение</span>
              <input
                className="field"
                value={draft.fieldValue}
                onChange={(event) => patch({ fieldValue: event.target.value })}
                placeholder="Например: Принят"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IntegrationTab({
  connection,
  onMessage,
  onReload,
}: {
  connection: Record<string, any> | null;
  onMessage: (message: string) => void;
  onReload: () => Promise<void>;
}) {
  const [subdomain, setSubdomain] = useState(connection?.subdomain ?? '');
  const [code, setCode] = useState('');
  const [redirectUri, setRedirectUri] = useState('http://localhost:3000');

  async function openOAuth() {
    const query = new URLSearchParams({ subdomain }).toString();
    const result = await api<{ url: string }>(`/amo/oauth-url?${query}`);
    window.open(result.url, '_blank', 'noopener,noreferrer');
    onMessage('OAuth-окно открыто. После авторизации вставьте code в форму обмена.');
  }

  async function exchangeCode() {
    await api('/amo/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ subdomain, code, redirectUri }),
    });
    await onReload();
    onMessage('amoCRM подключена. Можно запускать полную синхронизацию.');
  }

  async function sync(type: 'FULL' | 'INCREMENTAL') {
    await api(type === 'FULL' ? '/amo/sync/full' : '/amo/sync', {
      method: 'POST',
      body: JSON.stringify({ type }),
    });
    await onReload();
    onMessage(type === 'FULL' ? 'Полная синхронизация запущена' : 'Инкрементальная синхронизация запущена');
  }

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">Интеграция amoCRM</h1>
          <p className="page-description">OAuth-подключение, webhooks URL и ручной запуск синхронизации.</p>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
        <section className="card">
          <div className="card-header">
            <div className="card-title">Подключение</div>
            <span className={`badge ${connection?.status === 'ACTIVE' ? 'badge-green' : 'badge-yellow'}`}>
              {connection?.status ?? 'не подключено'}
            </span>
          </div>
          <div className="card-body grid gap-4">
            <label>
              <span className="label">Домен amoCRM</span>
              <input
                className="field"
                value={subdomain}
                onChange={(event) => setSubdomain(event.target.value)}
                placeholder="company.amocrm.ru"
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <button className="btn btn-primary" type="button" onClick={openOAuth} disabled={!subdomain}>
                <PlugZap size={15} />
                Получить OAuth URL
              </button>
              <button className="btn" type="button" onClick={() => sync('FULL')} disabled={connection?.status !== 'ACTIVE'}>
                <Database size={15} />
                Полная синхронизация
              </button>
            </div>
            <label>
              <span className="label">Authorization code</span>
              <input className="field" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <label>
              <span className="label">Redirect URI</span>
              <input className="field" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} />
            </label>
            <button className="btn" type="button" onClick={exchangeCode} disabled={!subdomain || !code || !redirectUri}>
              Обменять code и подключить
            </button>
          </div>
        </section>

        <aside className="card">
          <div className="card-header">
            <div className="card-title">Статус</div>
          </div>
          <div className="card-body grid gap-3 text-sm">
            <InfoRow label="Аккаунт" value={connection?.accountName ?? 'не подключен'} />
            <InfoRow label="Домен" value={connection?.subdomain ?? '-'} />
            <InfoRow label="Последняя полная синхронизация" value={formatDateTime(connection?.lastFullSyncAt)} />
            <InfoRow label="Последняя инкрементальная" value={formatDateTime(connection?.lastIncrementalSyncAt)} />
            <InfoRow label="Webhook URL" value={connection?.webhookUrl ?? '-'} />
            <button className="btn" type="button" onClick={() => sync('INCREMENTAL')} disabled={connection?.status !== 'ACTIVE'}>
              <RefreshCw size={15} />
              Обновить данные сейчас
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

function SettingsTab({
  forecastSettings,
  options,
  onMessage,
  onReload,
}: {
  forecastSettings: ForecastSettings | null;
  options: Options | null;
  onMessage: (message: string) => void;
  onReload: () => Promise<void>;
}) {
  const [closingStageId, setClosingStageId] = useState('');
  const [shippingPipelineId, setShippingPipelineId] = useState('');
  const [shippingSuccessStageId, setShippingSuccessStageId] = useState('');
  const [probabilityMode, setProbabilityMode] = useState<'MANUAL' | 'AUTO' | 'HYBRID'>('HYBRID');
  const [manualProbability, setManualProbability] = useState<Record<string, string>>({});

  useEffect(() => {
    const settings = forecastSettings?.settings;
    setClosingStageId(settings?.closingStageId ?? '');
    setShippingPipelineId(settings?.shippingPipelineId ?? '');
    setShippingSuccessStageId(settings?.shippingSuccessStageId ?? '');
    setProbabilityMode(settings?.probabilityMode ?? 'HYBRID');
  }, [forecastSettings]);

  async function saveForecastSettings() {
    await api('/settings/forecast', {
      method: 'PATCH',
      body: JSON.stringify({
        closingStageId: closingStageId || undefined,
        shippingPipelineId: shippingPipelineId || undefined,
        shippingSuccessStageId: shippingSuccessStageId || undefined,
        probabilityMode,
      }),
    });
    await onReload();
    onMessage('Настройки прогноза сохранены');
  }

  async function saveProbability(stageId: string) {
    const raw = manualProbability[stageId];
    await api('/settings/stage-probability', {
      method: 'PATCH',
      body: JSON.stringify({
        stageId,
        manualPercent: raw === '' || raw === undefined ? null : Number(raw),
      }),
    });
    await onReload();
    onMessage('Вероятность этапа сохранена');
  }

  async function saveVisibility(managers: Manager[], groups: Group[]) {
    await api('/settings/visibility', {
      method: 'PATCH',
      body: JSON.stringify({
        managers: managers.map((item) => ({ id: item.id, isVisible: item.isVisible })),
        groups: groups.map((item) => ({ id: item.id, isVisible: item.isVisible })),
      }),
    });
    await onReload();
    onMessage('Видимость менеджеров и групп сохранена');
  }

  const allStages = (options?.pipelines ?? []).flatMap((pipeline) =>
    pipeline.stages.map((stage) => ({ ...stage, pipelineName: pipeline.name })),
  );
  const shippingStages =
    options?.pipelines.find((pipeline) => pipeline.id === shippingPipelineId)?.stages ?? [];
  const [visibilityManagers, setVisibilityManagers] = useState<Manager[]>([]);
  const [visibilityGroups, setVisibilityGroups] = useState<Group[]>([]);

  useEffect(() => {
    setVisibilityManagers(options?.managers ?? []);
    setVisibilityGroups(options?.groups ?? []);
  }, [options]);

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">Настройки проекта</h1>
          <p className="page-description">Прогноз, плечо отгрузки, вероятности этапов и видимость команды.</p>
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="card">
          <div className="card-header">
            <div className="card-title">Прогноз по воронке</div>
          </div>
          <div className="card-body grid gap-4">
            <label>
              <span className="label">Закрытые сделки считать по этапу</span>
              <select className="select" value={closingStageId} onChange={(event) => setClosingStageId(event.target.value)}>
                <option value="">Выберите этап</option>
                {allStages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.pipelineName} / {stage.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Воронка отгрузки</span>
              <select className="select" value={shippingPipelineId} onChange={(event) => setShippingPipelineId(event.target.value)}>
                <option value="">Выберите воронку</option>
                {(options?.pipelines ?? []).map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Успешный этап отгрузки</span>
              <select
                className="select"
                value={shippingSuccessStageId}
                onChange={(event) => setShippingSuccessStageId(event.target.value)}
              >
                <option value="">Выберите этап</option>
                {shippingStages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Режим вероятностей</span>
              <select
                className="select"
                value={probabilityMode}
                onChange={(event) => setProbabilityMode(event.target.value as 'MANUAL' | 'AUTO' | 'HYBRID')}
              >
                <option value="HYBRID">Ручные, иначе авто</option>
                <option value="MANUAL">Только ручные</option>
                <option value="AUTO">Только авто</option>
              </select>
            </label>
            <button className="btn btn-primary" type="button" onClick={saveForecastSettings}>
              <Save size={15} />
              Сохранить настройки прогноза
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div className="card-title">Вероятности этапов</div>
          </div>
          <div className="card-body grid max-h-[520px] gap-3 overflow-y-auto">
            {(forecastSettings?.probabilities ?? []).map((item) => (
              <div key={item.stageId} className="grid gap-2 rounded-[10px] border border-[var(--pb-border)] p-3 md:grid-cols-[1fr_120px_94px] md:items-center">
                <div>
                  <div className="font-semibold">{item.stage?.name}</div>
                  <div className="text-xs text-[var(--pb-text-secondary)]">
                    Авто: {formatPercent(item.autoPercent)} / выборка {item.sampleSize ?? 0}
                  </div>
                </div>
                <input
                  className="field"
                  inputMode="decimal"
                  placeholder={item.manualPercent == null ? '-' : String(item.manualPercent)}
                  value={manualProbability[item.stageId] ?? ''}
                  onChange={(event) => setManualProbability({ ...manualProbability, [item.stageId]: event.target.value })}
                />
                <button className="btn" type="button" onClick={() => saveProbability(item.stageId)}>
                  Сохранить
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="card xl:col-span-2">
          <div className="card-header">
            <div className="card-title">Видимость команды для РОПа</div>
            <button className="btn" type="button" onClick={() => saveVisibility(visibilityManagers, visibilityGroups)}>
              <Save size={15} />
              Сохранить видимость
            </button>
          </div>
          <div className="card-body grid gap-5 md:grid-cols-2">
            <div>
              <div className="label">Менеджеры</div>
              <div className="multi-picker max-h-[260px]">
                {visibilityManagers.map((manager) => (
                  <label key={manager.id} className="check-row">
                    <input
                      checked={manager.isVisible}
                      type="checkbox"
                      onChange={(event) =>
                        setVisibilityManagers((items) =>
                          items.map((item) =>
                            item.id === manager.id ? { ...item, isVisible: event.target.checked } : item,
                          ),
                        )
                      }
                    />
                    <span>{manager.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Группы</div>
              <div className="multi-picker max-h-[260px]">
                {visibilityGroups.map((group) => (
                  <label key={group.id} className="check-row">
                    <input
                      checked={group.isVisible}
                      type="checkbox"
                      onChange={(event) =>
                        setVisibilityGroups((items) =>
                          items.map((item) =>
                            item.id === group.id ? { ...item, isVisible: event.target.checked } : item,
                          ),
                        )
                      }
                    />
                    <span>{group.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function MultiCheckbox({
  label,
  onChange,
  options,
  values,
}: {
  label: string;
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string }>;
  values: string[];
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="multi-picker">
        {options.length === 0 && <div className="px-1 py-2 text-xs text-[var(--pb-text-secondary)]">Нет данных</div>}
        {options.map((option) => (
          <label key={option.value} className="check-row">
            <input
              checked={values.includes(option.value)}
              type="checkbox"
              onChange={(event) => {
                const next = event.target.checked
                  ? [...values, option.value]
                  : values.filter((value) => value !== option.value);
                onChange(next);
              }}
            />
            <span className="truncate">{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FieldCombobox({
  emptyText = 'Поля появятся после синхронизации amoCRM',
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  emptyText?: string;
  label: string;
  onChange: (value: string) => void;
  options: FieldOption[];
  placeholder: string;
  value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) =>
        `${option.label} ${option.description ?? ''} ${option.value}`.toLowerCase().includes(normalizedQuery),
      )
    : options;

  return (
    <div
      className="field-combobox"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setIsOpen(false);
      }}
    >
      <span className="label">{label}</span>
      <button
        className="field-combobox-trigger"
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
      >
        <span className={selected ? 'truncate' : 'truncate text-[var(--pb-text-muted)]'}>
          {selected?.label ?? placeholder}
        </span>
        <ArrowDown size={14} className="shrink-0 text-[var(--pb-text-secondary)]" />
      </button>

      {isOpen && (
        <div className="field-combobox-panel">
          <input
            className="field-combobox-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по CRM-полям"
            autoFocus
          />
          <div className="field-combobox-list">
            {filteredOptions.length === 0 && (
              <div className="px-2 py-2 text-xs text-[var(--pb-text-secondary)]">{emptyText}</div>
            )}
            {filteredOptions.map((option) => (
              <button
                key={`${option.value}:${option.label}`}
                className={`field-combobox-option ${option.value === value ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setQuery('');
                  setIsOpen(false);
                }}
              >
                <span className="truncate font-semibold">{option.label}</span>
                {option.description && <span className="truncate text-xs text-[var(--pb-text-secondary)]">{option.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportResultDetails({ result, template }: { result: Record<string, any> | null; template: ReportTemplate }) {
  if (!result) return <div className="muted text-sm">Нет данных для отображения.</div>;

  if (result.type === 'contract') {
    const rows = (result.rows ?? []) as Array<Record<string, any>>;
    const metrics = (result.metrics ?? []) as ContractMetricPayload[];
    const conversions = (result.conversions ?? []) as ContractConversionDraft[];
    const durations = (result.durations ?? []) as ContractDurationDraft[];
    return (
      <div className="grid gap-4">
        {rows.map((row) => (
          <div key={String(row.groupId)} className="rounded-[10px] border border-[var(--pb-border)] bg-white p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="font-semibold">{String(row.groupName)}</div>
              <span className="badge">{metrics.length} показателей</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {metrics.map((metric) => {
                const value = (row.metrics as Record<string, any>)?.[metric.id] ?? {};
                return (
                  <div key={metric.id} className="rounded-[8px] bg-[var(--pb-bg)] p-3">
                    <div className="truncate text-xs font-bold uppercase text-[var(--pb-text-secondary)]" title={metric.label}>
                      {metric.label}
                    </div>
                    <div className="mt-2 mono-num text-2xl font-bold">{formatMetricValue(value.value, value.unit)}</div>
                    {metric.type !== 'conversion' && (
                      <div className="mt-1 text-xs text-[var(--pb-text-secondary)]">
                        Сделок в выборке: {formatNumber(value.dealCount ?? 0)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(conversions.length > 0 || durations.length > 0) && (
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {conversions.map((conversion) => {
                  const value = (row.conversions as Record<string, any>)?.[conversion.id] ?? {};
                  return (
                    <InfoRow
                      key={conversion.id}
                      label={conversion.label}
                      value={value.conversion == null ? 'нет данных' : `${formatNumber(value.conversion)}%`}
                    />
                  );
                })}
                {durations.map((duration) => {
                  const value = (row.durations as Record<string, any>)?.[duration.id] ?? {};
                  return (
                    <InfoRow
                      key={duration.id}
                      label={duration.label}
                      value={value.avgDays == null ? 'нет данных' : `${formatNumber(value.avgDays)} дн.`}
                    />
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (result.type === 'forecast') {
    const forecast = result.forecast ?? {};
    return (
      <div className="grid gap-2 text-sm">
        <InfoRow label="Закрыто в месяце" value={formatMoney(forecast.closedAmount)} />
        <InfoRow label="Взвешенная воронка" value={formatMoney(forecast.weightedAmount)} />
        <InfoRow label="Плечо отгрузки" value={formatDays(forecast.shippingShoulder?.medianDays ?? forecast.shippingShoulder?.avgDays)} />
      </div>
    );
  }

  if (result.type === 'conversion') {
    const steps = (result.steps ?? []) as Array<Record<string, any>>;
    if (steps.length === 0) return <div className="muted text-sm">За период событий не найдено.</div>;
    if (template.config.display === 'table') {
      return (
        <table className="table text-sm">
          <thead>
            <tr>
              <th>Шаг</th>
              <th>Кол-во</th>
              <th>Конверсия</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <tr key={step.id}>
                <td title={step.label}>{step.label}</td>
                <td className="mono-num">{step.count}</td>
                <td className="mono-num">{step.conversion == null ? '-' : `${step.conversion}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return (
      <div className="grid gap-3">
        {steps.map((step) => (
          <div key={step.id} className="grid gap-1">
            <div className="flex justify-between gap-3 text-sm">
              <span className="truncate">{step.label}</span>
              <span className="mono-num font-semibold">{step.count}</span>
            </div>
            <div className="progress">
              <div className="progress-fill" style={{ width: `${Math.min(100, Number(step.conversion ?? 100))}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const rows = (result.rows ?? []) as Array<Record<string, any>>;
  if (template.config.display === 'table') {
    return (
      <table className="table text-sm">
        <thead>
          <tr>
            <th>Сделка</th>
            <th>Этап</th>
            <th>Сумма</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 6).map((row) => (
            <tr key={row.id}>
              <td title={row.title}>{row.title}</td>
              <td title={row.stage}>{row.stage}</td>
              <td className="mono-num">{formatMoney(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return <div className="muted text-sm">Сделок в выборке: {(result.summary?.count ?? 0) as number}</div>;
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b border-[var(--pb-border)] py-2 last:border-b-0">
      <span className="text-[var(--pb-text-secondary)]">{label}</span>
      <span className="min-w-0 max-w-[60%] truncate text-right font-semibold" title={typeof value === 'string' ? value : undefined}>
        {value}
      </span>
    </div>
  );
}

function normalizeTemplates(items: ReportTemplate[], layout?: DashboardLayout): ReportTemplate[] {
  return orderTemplates(items.map((item) => normalizeTemplate(item, layout?.config)));
}

function normalizeTemplate(item: ReportTemplate, layout?: DashboardLayout['config']): ReportTemplate {
  const layoutItem = layout?.reports?.[item.id];
  const config = (item.config ?? {}) as ReportConfig;
  return {
    ...item,
    config: {
      ...config,
      filters: config.filters ?? getInitialFilters(),
      metric: config.metric ?? 'count',
      display: config.display ?? (config.metric === 'forecast' ? 'forecast' : config.metric === 'contract' ? 'table' : 'kpi'),
      denominator: config.denominator ?? 'previous',
      pinned: Boolean(layoutItem?.pinned ?? config.pinned ?? false),
      size: layoutItem?.size ?? config.size ?? 'md',
      order: Number(layoutItem?.order ?? config.order ?? item.position ?? 0),
    },
  };
}

function orderTemplates(items: ReportTemplate[]) {
  return [...items].sort((a, b) => Number(a.config.order ?? 0) - Number(b.config.order ?? 0));
}

function upsertTemplate(items: ReportTemplate[], next: ReportTemplate) {
  const exists = items.some((item) => item.id === next.id);
  if (!exists) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

function buildLayoutConfig(templates: ReportTemplate[]) {
  return {
    reports: Object.fromEntries(
      templates.map((template, index) => [
        template.id,
        {
          pinned: Boolean(template.config.pinned),
          order: Number(template.config.order ?? index + 1),
          size: template.config.size ?? 'md',
        },
      ]),
    ),
  };
}

function applyOptionDefaults(draft: ReportDraft, options: Options | null): ReportDraft {
  const firstPipeline = options?.pipelines[0];
  if (!draft.pipelineId && firstPipeline) return { ...draft, pipelineId: firstPipeline.id };
  return draft;
}

function reportToDraft(template: ReportTemplate): ReportDraft {
  const builder = template.config.builder;
  if (builder) {
    return {
      ...getDefaultDraft(),
      ...builder,
      name: template.name,
      description: template.config.description ?? builder.description ?? '',
      metric: template.config.metric ?? builder.metric ?? 'count',
      display: template.config.display ?? builder.display ?? 'kpi',
      denominator: template.config.denominator ?? builder.denominator ?? 'previous',
      pinned: Boolean(template.config.pinned),
      size: template.config.size ?? builder.size ?? 'md',
    };
  }
  if (template.config.contract) {
    return {
      ...getDefaultDraft(),
      mode: 'contract',
      name: template.name,
      description: template.config.description ?? '',
      metric: 'contract',
      display: 'table',
      contractGroupBy: template.config.contract.groupBy ?? 'manager',
      contractMetrics: (template.config.contract.metrics ?? []).map((metric) => ({
        id: metric.id,
        label: metric.label,
        type: metric.type,
        measure: metric.measure ?? (metric.valueFieldId || metric.amountFieldId || metric.marginFieldId ? 'field_sum' : 'deal_count'),
        display: metric.display ?? (metric.type === 'conversion' ? 'percent' : metric.valueFieldId || metric.amountFieldId || metric.marginFieldId ? 'money' : 'number'),
        pipelineId: metric.pipelineId ?? '',
        fromStageId: metric.fromStageId ?? '',
        stageIds: metric.stageIds ?? [],
        fieldId: metric.fieldId ?? '',
        fieldOperator: metric.fieldOperator ?? 'equals',
        fieldValue: String(metric.fieldValue ?? ''),
        valueFieldId: metric.valueFieldId ?? metric.amountFieldId ?? metric.marginFieldId ?? '',
        fromMetricId: metric.fromMetricId ?? '',
        toMetricId: metric.toMetricId ?? '',
      })),
      contractConversions: template.config.contract.conversions ?? [],
      contractDurations: template.config.contract.durations ?? [],
      pinned: Boolean(template.config.pinned),
      size: template.config.size ?? 'lg',
    };
  }
  return {
    ...getDefaultDraft(),
    name: template.name,
    description: template.config.description ?? '',
    metric: template.config.metric ?? 'count',
    display: template.config.display ?? 'kpi',
    denominator: template.config.denominator ?? 'previous',
    pinned: Boolean(template.config.pinned),
    size: template.config.size ?? 'md',
  };
}

