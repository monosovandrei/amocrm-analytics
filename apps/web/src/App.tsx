'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  Dispatch,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SetStateAction,
} from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  Eye,
  EyeOff,
  Filter,
  GripVertical,
  LayoutDashboard,
  LogOut,
  Mail,
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
import { api, downloadExcel, downloadFile } from '@/lib/api';
import type {
  BuilderOperator,
  ContractConversionDraft,
  ContractDisplay,
  ContractDurationDraft,
  ContractFilterDraft,
  ContractFilterOperator,
  ContractFilterSubject,
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
  AlertRule,
  PlanFactCell,
  PlanFactMetric,
  PlanFactReport,
  PlanFactTeam,
  PlanFactTargetRow,
  PlanFactRow,
  PlanSet,
  PeriodMode,
  PeriodPreset,
  PlatformBusinessRole,
  Pipeline,
  PipelineStage,
  PlatformOverview,
  QualityRule,
  QualityViolation,
  RelativeUnit,
  ReportConfig,
  ReportDraft,
  ReportFilters,
  ReportSchedule,
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
  formatDurationFromDays,
  formatMetricValue,
  formatMoney,
  formatMoscowDateTime,
  formatNumber,
  formatPercent,
  getFieldName,
  getMetric,
  getStageName,
  validateDraft,
} from './report-utils';

type AppTab = Tab | 'leadSla' | 'planFact' | 'emailThreads';

const navItems: Array<{ id: AppTab; label: string; icon: ReactNode }> = [
  { id: 'workspace', label: 'Отчёты', icon: <LayoutDashboard size={17} /> },
  { id: 'planFact', label: 'План-факт', icon: <BarChart3 size={17} /> },
  { id: 'leadSla', label: 'SLA лидов', icon: <Clock3 size={17} /> },
  { id: 'emailThreads', label: 'Почта', icon: <Mail size={17} /> },
  { id: 'platform', label: 'Telegram', icon: <Activity size={17} /> },
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
  revenue_profit_forecast: 'Прогноз выручки',
  contract: 'Контракт данных',
  deal_cycle: 'Цикл сделки',
  deal_stage_age: 'Текущие этапы',
  loss_reasons: 'Причины отказа',
};

const displayLabels: Record<DisplayType, string> = {
  kpi: 'KPI-виджет',
  funnel: 'Воронка',
  table: 'Таблица',
  forecast: 'Прогноз',
  cycle: 'Циклы сделки',
};

const sizeLabels: Record<WidgetSize, string> = {
  sm: '1 колонка',
  md: '2 колонки',
  lg: '4 колонки',
};

type LeadSlaCard = {
  dealId: string;
  dealExternalId: string;
  title: string;
  amount: number;
  managerName: string;
  groupName: string;
  pipelineName: string;
  stageName: string;
  createdAt: string;
  startAt: string;
  dueAt: string;
  elapsedSeconds: number;
  remainingSeconds: number;
  progressPercent: number;
  status: 'waiting' | 'active' | 'warning' | 'overdue';
  statusLabel: string;
  dealUrl: string;
};

type LeadSlaResponse = {
  now: string;
  timezone: string;
  slaMinutes: number;
  workTime: string;
  warning?: string;
  summary: {
    total: number;
    waiting: number;
    active: number;
    warning: number;
    overdue: number;
  };
  cards: LeadSlaCard[];
};

type PendingEmailMessage = {
  id: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  subject?: string | null;
  summary?: string | null;
  body?: string | null;
  from?: string | null;
  to?: string | null;
  attachCount: number;
  deliveryStatus?: string | null;
  source: 'note' | 'event';
};

type EmailPipelineKey = 'sales' | 'base' | 'assignedCompanies';

type PendingEmailThread = {
  id: string;
  pipelineKey: EmailPipelineKey;
  dealId: string;
  dealExternalId: string;
  title: string;
  amount: number;
  managerName: string;
  managerExternalId?: string | null;
  groupName: string;
  pipelineName: string;
  stageName: string;
  contactName?: string | null;
  contactEmail?: string | null;
  threadId: string;
  lastIncomingNoteExternalId: string;
  lastIncomingAt: string;
  waitingSeconds: number;
  subject?: string | null;
  summary?: string | null;
  attachCount: number;
  dealUrl: string;
  messages: PendingEmailMessage[];
};

type PendingEmailThreadGroup = {
  key: EmailPipelineKey;
  label: string;
  summary: {
    total: number;
    olderThan1h: number;
    olderThan4h: number;
    olderThan24h: number;
  };
  threads: PendingEmailThread[];
};

type PendingEmailThreadsResponse = {
  now: string;
  timezone: string;
  summary: {
    total: number;
    olderThan1h: number;
    olderThan4h: number;
    olderThan24h: number;
  };
  groups?: PendingEmailThreadGroup[];
  threads: PendingEmailThread[];
};

type LinkedCrmUser = {
  id: string;
  externalId: string;
  name: string;
  email?: string | null;
  group?: { id: string; name: string } | null;
};

type TelegramAccountSummary = {
  id: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isActive: boolean;
  linkedAt: string;
};

type PlatformUserLink = User & {
  businessRole: PlatformBusinessRole;
  crmUserId?: string | null;
  crmUser?: (LinkedCrmUser & { isActive?: boolean }) | null;
  telegramAccount?: TelegramAccountSummary | null;
};

type UserLinksResponse = {
  users: PlatformUserLink[];
  crmUsers: LinkedCrmUser[];
};

type CrmTelegramLink = LinkedCrmUser & {
  isActive: boolean;
  telegramAccount?: TelegramAccountSummary | null;
  activeCode?: {
    id: string;
    code: string;
    expiresAt: string;
    createdAt: string;
  } | null;
};

type CrmTelegramLinksResponse = {
  crmUsers: CrmTelegramLink[];
};

type TelegramTemplateRecipient = {
  kind: 'platform_user' | 'crm_user';
  id: string;
};

type TelegramRecipientMode = 'default' | 'custom';
type TelegramDeliveryMode = 'system' | 'direct_responsible' | 'selected' | 'group' | 'all_connected' | 'disabled';

type TelegramTemplate = {
  eventType: string;
  name: string;
  body: string;
  recipients?: TelegramTemplateRecipient[];
  recipientsMode?: TelegramRecipientMode;
  deliveryMode?: TelegramDeliveryMode;
  allowedDeliveryModes?: TelegramDeliveryMode[];
};

const telegramDeliveryModeLabels: Record<TelegramDeliveryMode, string> = {
  system: 'По системному правилу',
  direct_responsible: 'В ЛС ответственному',
  selected: 'Выбранным получателям',
  group: 'В активную группу',
  all_connected: 'Всем подключённым',
  disabled: 'Не отправлять',
};

const telegramDeliveryModeOrder: TelegramDeliveryMode[] = [
  'system',
  'direct_responsible',
  'selected',
  'group',
  'all_connected',
  'disabled',
];

const telegramDeliveryModeHints: Record<TelegramDeliveryMode, string> = {
  system: 'Используется встроенная логика события.',
  direct_responsible: 'Получит только менеджер, к которому относится сделка.',
  selected: 'Получат только выбранные люди.',
  group: 'Сообщение уйдёт в подключённую группу.',
  all_connected: 'Сообщение уйдёт всем подключённым аккаунтам.',
  disabled: 'Уведомление выключено.',
};

type UserLinkDraft = {
  businessRole: PlatformBusinessRole;
  crmUserId: string;
};

const periodPresetLabels: Record<PeriodPreset, string> = {
  today: 'За сегодня',
  yesterday: 'За вчера',
  this_week: 'За эту неделю',
  last_week: 'Прошлая неделя',
  this_month: 'За этот месяц',
  last_month: 'Прошлый месяц',
};

const workspacePeriodPresets: PeriodPreset[] = ['today', 'yesterday', 'this_week', 'this_month'];

const relativeUnitLabels: Record<RelativeUnit, string> = {
  hours: 'часов',
  days: 'дней',
  weeks: 'недель',
  months: 'месяцев',
};

const filterSubjectLabels: Record<ContractFilterSubject, string> = {
  deal_created_at: 'Дата создания сделки',
  deal_updated_at: 'Дата изменения сделки',
  deal_closed_at: 'Дата закрытия сделки',
  deal_expected_close_at: 'Ожидаемая дата закрытия',
  deal_amount: 'Бюджет сделки',
  deal_stage: 'Текущий этап',
  deal_responsible: 'Ответственный',
  deal_group: 'Группа ответственного',
  deal_field: 'Поле сделки amoCRM',
  last_note_created_at: 'Дата последнего примечания',
  last_note_text: 'Текст последнего примечания',
  task_created_at: 'Дата создания задачи',
  task_updated_at: 'Дата изменения задачи',
  task_due_at: 'Срок задачи',
  task_completed_at: 'Дата выполнения задачи',
  task_type: 'Тип задачи',
  task_status: 'Статус задачи',
  task_text: 'Текст задачи',
  task_responsible: 'Ответственный',
  task_group: 'Группа ответственного',
};

const filterOperatorLabels: Record<ContractFilterOperator, string> = {
  equals: 'равно',
  contains: 'содержит',
  is_set: 'заполнено',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  within_last: 'за последние',
  older_than: 'старше чем',
};

const taskStatusLabels: Record<string, string> = {
  planned_today: 'Запланирована на сегодня',
  overdue: 'Просрочена',
  completed: 'Выполнена',
  planned_future: 'Запланирована на будущее',
  no_due: 'Без срока',
};

function isWideMetric(metric?: MetricType) {
  return (
    metric === 'contract' ||
    metric === 'deal_cycle' ||
    metric === 'deal_stage_age' ||
    metric === 'revenue_profit_forecast' ||
    metric === 'loss_reasons'
  );
}

function defaultDisplayForMetric(metric?: MetricType): DisplayType {
  if (metric === 'forecast' || metric === 'revenue_profit_forecast') return 'forecast';
  if (metric === 'deal_cycle' || metric === 'deal_stage_age') return 'cycle';
  if (metric === 'contract' || metric === 'loss_reasons') return 'table';
  return 'kpi';
}

function getInitialFilters(): ReportFilters {
  const now = new Date();
  return {
    periodMode: 'preset',
    periodPreset: 'this_month',
    relativeAmount: 7,
    relativeUnit: 'days',
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

function dateInputValue(value?: string) {
  if (!value) return '';
  return value.slice(0, 10);
}

function presetDateInputs(preset: PeriodPreset) {
  const now = new Date();
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = now.getDay() || 7;

  if (preset === 'today') {
    return { dateFrom: toDateInput(now), dateTo: toDateInput(now) };
  }

  if (preset === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return { dateFrom: toDateInput(yesterday), dateTo: toDateInput(yesterday) };
  }

  if (preset === 'this_week') {
    const monday = startOfDay(now);
    monday.setDate(monday.getDate() - day + 1);
    return { dateFrom: toDateInput(monday), dateTo: toDateInput(now) };
  }

  return {
    dateFrom: toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)),
    dateTo: toDateInput(now),
  };
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
    formula: '',
    extraFilters: [],
  };
}

function createContractFilter(): ContractFilterDraft {
  return {
    id: makeId('filter'),
    subject: 'deal_field',
    fieldId: '',
    operator: 'equals',
    value: '',
    amount: 1,
    unit: 'days',
  };
}

function createTaskFilter(subject: ContractFilterSubject, value: string): ContractFilterDraft {
  return {
    id: makeId('filter'),
    subject,
    fieldId: '',
    operator: 'equals',
    value,
    amount: 1,
    unit: 'days',
  };
}

function createTaskMetric(label: string, filters: ContractFilterDraft[] = []): ContractMetricDraft {
  return {
    ...createContractMetric(label, 'task_count'),
    display: 'number',
    extraFilters: filters,
  };
}

function getDefaultTaskMetrics() {
  return [
    createTaskMetric('Задачи на сегодня', [createTaskFilter('task_status', 'planned_today')]),
    createTaskMetric('Просроченные задачи', [createTaskFilter('task_status', 'overdue')]),
  ];
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
      ...createContractMetric('Конверсия лид > квалификация', 'conversion'),
      fromMetricId: metrics[0]?.id ?? '',
      toMetricId: metrics[2]?.id ?? '',
    },
    {
      ...createContractMetric('Конверсия квалификация > КП', 'conversion'),
      fromMetricId: metrics[2]?.id ?? '',
      toMetricId: metrics[3]?.id ?? '',
    },
    {
      ...createContractMetric('Конверсия КП > счёт', 'conversion'),
      fromMetricId: metrics[3]?.id ?? '',
      toMetricId: metrics[4]?.id ?? '',
    },
    {
      ...createContractMetric('Конверсия счёт > оплата', 'conversion'),
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
    visibleUserIds: [],
    includeRowTotal: false,
    rowTotalMode: 'sum',
    includeSummaryRow: true,
    summaryRowMode: 'sum',
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
  const [tab, setTab] = useState<AppTab>('workspace');
  const [options, setOptions] = useState<Options | null>(null);
  const [connection, setConnection] = useState<Record<string, any> | null>(null);
  const [syncHealth, setSyncHealth] = useState<Record<string, any> | null>(null);
  const [forecastSettings, setForecastSettings] = useState<ForecastSettings | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [filters, setFilters] = useState<ReportFilters>(getInitialFilters);
  const [draft, setDraft] = useState<ReportDraft>(getDefaultDraft);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [message, setMessage] = useState('');
  const [refreshStamp, setRefreshStamp] = useState(0);
  const lastAmoSyncSeenRef = useRef<string | null>(null);

  const loadData = useCallback(async () => {
    const [nextOptions, nextConnection, nextSyncHealth, nextForecast, nextTemplates, nextLayout] = await Promise.all([
      api<Options>('/settings/options'),
      api<Record<string, any> | null>('/amo/connection'),
      api<Record<string, any> | null>('/amo/sync/health').catch(() => null),
      api<ForecastSettings>('/settings/forecast'),
      api<ReportTemplate[]>('/reports/templates'),
      api<DashboardLayout>('/settings/dashboard-layout').catch(() => ({ config: {} })),
    ]);
    setOptions(nextOptions);
    setConnection(nextConnection);
    setSyncHealth(nextSyncHealth);
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
  const canAccessTelegram = user?.businessRole === 'OWNER';
  const visibleNavItems = canAccessTelegram ? navItems : navItems.filter((item) => item.id !== 'platform');
  const amoHasConnection = Boolean(connection?.subdomain);
  const amoConnected = amoHasConnection && connection?.status !== 'INACTIVE';
  const lastAmoSyncAt = syncHealth?.lastDataUpdateAt ?? syncHealth?.lastSuccessfulSyncAt ?? connection?.lastIncrementalSyncAt ?? connection?.lastFullSyncAt;
  const amoRealtimeWaitingForFirstWebhook = syncHealth?.syncMode === 'WEBHOOK' && syncHealth?.hasReceivedWebhooks === false;
  const amoConnectionHealthy = amoConnected && syncHealth?.healthy !== false;
  const amoStatusText = syncHealth?.message ?? (amoConnectionHealthy ? 'Синхронизация работает' : 'Синхронизация не работает');
  const amoSyncUpdatedText = amoRealtimeWaitingForFirstWebhook && lastAmoSyncAt
    ? `Данные: ${formatMoscowDateTime(lastAmoSyncAt)} МСК`
    : lastAmoSyncAt
      ? `Обновлено: ${formatMoscowDateTime(lastAmoSyncAt)} МСК`
      : 'Данные ещё не обновлялись';

  useEffect(() => {
    if (tab === 'platform' && !canAccessTelegram) {
      setTab('workspace');
    }
  }, [canAccessTelegram, tab]);

  useEffect(() => {
    if (!user) return;
    const currentSyncAt = String(lastAmoSyncAt ?? '');
    if (currentSyncAt) {
      lastAmoSyncSeenRef.current = currentSyncAt;
    }
  }, [lastAmoSyncAt, user]);

  useEffect(() => {
    if (!user || !amoHasConnection) return;

    let cancelled = false;
    const pollConnection = async () => {
      try {
        const [nextConnection, nextSyncHealth] = await Promise.all([
          api<Record<string, any> | null>('/amo/connection'),
          api<Record<string, any> | null>('/amo/sync/health').catch(() => null),
        ]);
        if (cancelled || !nextConnection) return;

        setConnection(nextConnection);
        setSyncHealth(nextSyncHealth);
        const nextSyncAt = String(
          nextSyncHealth?.lastDataUpdateAt ??
          nextSyncHealth?.lastSuccessfulSyncAt ??
          nextConnection.lastIncrementalSyncAt ??
          nextConnection.lastFullSyncAt ??
          '',
        );
        if (nextSyncAt && lastAmoSyncSeenRef.current && nextSyncAt !== lastAmoSyncSeenRef.current) {
          lastAmoSyncSeenRef.current = nextSyncAt;
          setRefreshStamp((value) => value + 1);
        } else if (nextSyncAt) {
          lastAmoSyncSeenRef.current = nextSyncAt;
        }
      } catch {
        // Reports stay on the last loaded data if the status poll fails.
      }
    };

    const timer = window.setInterval(() => void pollConnection(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [amoHasConnection, user]);

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
    const source = templates.find((item) => item.id === id);
    if (!source) return;
    const section = dashboardSectionKey(source);
    const visible = orderTemplates(templates.filter((item) => item.config.pinned && dashboardSectionKey(item) === section));
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
      <section className="app-main">
        <header className="topbar">
          <div className="topbar-main">
            <div className="topbar-brand">
              <div className="topbar-logo">
                <BarChart3 size={20} />
              </div>
              <div>
                <div className="text-base font-bold">amoCRM Analytics</div>
                <div className="text-xs text-[var(--pb-text-secondary)]">Рабочий стол РОПа</div>
              </div>
            </div>

            <nav className="topbar-nav" aria-label="Основное меню">
              {visibleNavItems.map((item) => (
                <button
                  key={item.id}
                  className={`topbar-nav-item ${tab === item.id ? 'active' : ''}`}
                  onClick={() => setTab(item.id)}
                  type="button"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="topbar-actions">
            <div
              className={`sync-panel ${amoConnectionHealthy ? 'sync-panel-ok' : 'sync-panel-warn'}`}
              title={`${syncHealth?.message ?? amoStatusText}. ${amoSyncUpdatedText}`}
            >
              {amoConnectionHealthy ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
              <div className="min-w-0">
                <div className="sync-panel-title">{amoStatusText}</div>
                <div className="sync-panel-meta">{amoSyncUpdatedText}</div>
              </div>
            </div>
            <div className="topbar-user">
                <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
                <div className="topbar-user-text">
                  <div className="truncate text-sm font-semibold">{user.name}</div>
                <div className="truncate text-xs text-[var(--pb-text-muted)]">{businessRoleLabel(user.businessRole)}</div>
                </div>
              <button
                className="icon-btn"
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
                amoDomain={connection?.subdomain ?? ''}
                filters={filters}
                options={options}
                reportTemplates={ordered}
                refreshStamp={refreshStamp}
                onSetFilters={setFilters}
              />
            )}

            {tab === 'planFact' && (
              <PlanFactTab refreshStamp={refreshStamp} />
            )}

            {tab === 'leadSla' && (
              <LeadSlaTab />
            )}

            {tab === 'emailThreads' && (
              <EmailThreadsTab onMessage={setMessage} />
            )}

            {tab === 'platform' && canAccessTelegram && (
              <PlatformTab
                user={user}
                onMessage={setMessage}
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
          <span className="label">Логин</span>
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
  amoDomain,
  filters,
  options,
  reportTemplates,
  refreshStamp,
  onSetFilters,
}: {
  amoDomain: string;
  filters: ReportFilters;
  options: Options | null;
  reportTemplates: ReportTemplate[];
  refreshStamp: number;
  onSetFilters: (filters: ReportFilters) => void;
}) {
  const [sectionOpen, setSectionOpen] = useState<Record<'sales' | 'csm' | 'forecast', boolean>>({
    sales: true,
    csm: true,
    forecast: true,
  });
  const salesTemplates = reportTemplates.filter((template) => dashboardSectionKey(template) === 'sales');
  const csmTemplates = reportTemplates.filter((template) => dashboardSectionKey(template) === 'csm');
  const forecastTemplates = reportTemplates.filter((template) => dashboardSectionKey(template) === 'forecast');

  const renderWidget = (template: ReportTemplate) => (
    <ReportWidget
      key={template.id}
      amoDomain={amoDomain}
      filters={filters}
      refreshStamp={refreshStamp}
      template={template}
    />
  );

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">Отчёты</h1>
          <p className="page-description">
            Продажи, CSM и прогноз по актуальным данным amoCRM.
          </p>
        </div>
      </div>

      <WorkspaceFilters filters={filters} onSetFilters={onSetFilters} />

      {reportTemplates.length === 0 ? (
        <div className="empty-state">
          <div>
            <div className="mx-auto grid h-11 w-11 place-items-center rounded-[10px] bg-white text-[var(--pb-primary)] shadow-sm">
              <LayoutDashboard size={22} />
            </div>
            <h2 className="mt-4 text-lg font-bold">Отчётов пока нет</h2>
            <p className="mt-2 max-w-[560px] text-sm text-[var(--pb-text-secondary)]">
              Отчёты добавляются через код и появятся здесь после обновления сервиса.
            </p>
          </div>
        </div>
      ) : (
        <div className="dashboard-sections">
          {salesTemplates.length > 0 && (
            <DashboardSection
              count={salesTemplates.length}
              isOpen={sectionOpen.sales}
              title="Продажи"
              onToggle={() => setSectionOpen((current) => ({ ...current, sales: !current.sales }))}
            >
              {salesTemplates.map(renderWidget)}
            </DashboardSection>
          )}
          {csmTemplates.length > 0 && (
            <DashboardSection
              count={csmTemplates.length}
              isOpen={sectionOpen.csm}
              title="CSM"
              onToggle={() => setSectionOpen((current) => ({ ...current, csm: !current.csm }))}
            >
              {csmTemplates.map(renderWidget)}
            </DashboardSection>
          )}
          {forecastTemplates.length > 0 && (
            <DashboardSection
              count={forecastTemplates.length}
              isOpen={sectionOpen.forecast}
              title="Прогноз"
              onToggle={() => setSectionOpen((current) => ({ ...current, forecast: !current.forecast }))}
            >
              {forecastTemplates.map(renderWidget)}
            </DashboardSection>
          )}
        </div>
      )}
    </>
  );
}

function DashboardSection({
  children,
  count,
  isOpen,
  onToggle,
  title,
}: {
  children: ReactNode;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <section className="dashboard-section">
      <button className="dashboard-section-header" type="button" onClick={onToggle} aria-expanded={isOpen}>
        <span className="dashboard-section-title">
          {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          {title}
        </span>
        <span className="dashboard-section-count">{formatNumber(count)} отчётов</span>
      </button>
      {isOpen && <div className="dashboard-grid">{children}</div>}
    </section>
  );
}

function WorkspaceFilters({
  filters,
  onSetFilters,
}: {
  filters: ReportFilters;
  onSetFilters: (filters: ReportFilters) => void;
}) {
  function setPreset(preset: PeriodPreset) {
    onSetFilters({
      ...filters,
      ...presetDateInputs(preset),
      periodMode: 'preset',
      periodPreset: preset,
    });
  }

  return (
    <div className="card filter-card">
      <div className="card-header">
        <div>
          <div className="card-title">Период отчётов</div>
          <div className="filter-card-caption">Команды и воронки закреплены в каждом отчёте</div>
        </div>
        <span className="badge">
          <CalendarDays size={14} />
          {formatFilterPeriod(filters)}
        </span>
      </div>
      <div className="card-body">
        <div className="workspace-presets">
          {workspacePeriodPresets.map((preset) => (
            <button
              key={preset}
              className={`segmented-option ${filters.periodMode === 'preset' && filters.periodPreset === preset ? 'active' : ''}`}
              type="button"
              onClick={() => setPreset(preset)}
            >
              {periodPresetLabels[preset]}
            </button>
          ))}
        </div>

        <div className="toolbar">
          <label>
            <span className="label">Дата с</span>
            <input
              className="field"
              type="date"
              value={dateInputValue(filters.dateFrom)}
              onChange={(event) => onSetFilters({ ...filters, periodMode: 'custom', dateFrom: event.target.value })}
            />
          </label>
          <label>
            <span className="label">Дата по</span>
            <input
              className="field"
              type="date"
              value={dateInputValue(filters.dateTo)}
              onChange={(event) => onSetFilters({ ...filters, periodMode: 'custom', dateTo: event.target.value })}
            />
          </label>
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

function formatFilterPeriod(filters: ReportFilters) {
  if (filters.periodMode === 'preset' && filters.periodPreset) {
    return periodPresetLabels[filters.periodPreset];
  }
  if (filters.periodMode === 'relative') {
    return `Последние ${filters.relativeAmount ?? 0} ${relativeUnitLabels[filters.relativeUnit ?? 'days']}`;
  }
  const from = dateInputValue(filters.dateFrom) || '...';
  const to = dateInputValue(filters.dateTo) || '...';
  return `${from} - ${to}`;
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
        {templates.map((template) => {
          const isContract = template.config.metric === 'contract';
          return (
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
            {isContract ? (
              <span />
            ) : (
              <select
                className="select"
                value={template.config.size ?? 'md'}
                onChange={(event) => onUpdateLayout(template.id, { size: event.target.value as WidgetSize })}
              >
                <option value="sm">{sizeLabels.sm}</option>
                <option value="md">{sizeLabels.md}</option>
                <option value="lg">{sizeLabels.lg}</option>
              </select>
            )}
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
          );
        })}
      </div>
    </div>
  );
}

function ReportWidget({
  amoDomain,
  filters,
  refreshStamp,
  template,
}: {
  amoDomain: string;
  filters: ReportFilters;
  refreshStamp: number;
  template: ReportTemplate;
}) {
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const hasLoadedRef = useRef(false);

  const query = useMemo(() => buildQueryFromTemplate(template, filters), [template, filters]);
  const cacheKey = useMemo(() => reportWidgetCacheKey(query), [query]);

  useEffect(() => {
    const cached = readReportWidgetCache(cacheKey);
    setResult(cached);
    setLoading(!cached);
    setError('');
    hasLoadedRef.current = Boolean(cached);
  }, [cacheKey]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const initialLoad = !hasLoadedRef.current;
      setLoading(initialLoad);
      if (initialLoad) setError('');
      try {
        const next = await api<Record<string, any>>('/reports/compute', {
          method: 'POST',
          body: JSON.stringify(query),
        });
        if (!cancelled) {
          setResult(next);
          writeReportWidgetCache(cacheKey, next);
          hasLoadedRef.current = true;
        }
      } catch (err) {
        if (!cancelled && initialLoad) {
          setError(err instanceof Error ? err.message : 'Не удалось посчитать отчёт');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, query, refreshStamp]);

  const metric = getMetric(template, result);
  const isWideReport = isWideMetric(template.config.metric);
  const size = isWideReport ? 'contract' : template.config.size ?? 'md';

  return (
    <article className={`card card-hover widget-${size}`} data-testid={`widget-${template.id}`}>
      <div className="card-header">
        <div className="min-w-0">
          <div className="card-title truncate">{template.name}</div>
          <div className="mt-1 truncate text-xs text-[var(--pb-text-secondary)]">{template.config.conditionLabel}</div>
        </div>
      </div>
      <div className="card-body grid gap-4">
        {loading && <div className="muted text-sm">Считаю по данным amoCRM...</div>}
        {error && <div className="badge badge-red justify-start">{error}</div>}
        {!loading && !error && result && (
          <>
            <div>
              <div className="metric-value mono-num">{metric.value}</div>
              <div className="metric-caption">
                {metric.caption}
              </div>
            </div>
            <ReportResultDetails amoDomain={amoDomain} result={result} template={template} />
          </>
        )}
      </div>
    </article>
  );
}

function reportWidgetCacheKey(query: Record<string, any>) {
  return `amocrm-report:${hashString(stableStringify(query))}`;
}

function readReportWidgetCache(cacheKey: string) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.result && typeof parsed.result === 'object' ? parsed.result as Record<string, any> : null;
  } catch {
    return null;
  }
}

function writeReportWidgetCache(cacheKey: string, result: Record<string, any>) {
  if (typeof window === 'undefined') return;
  try {
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), result });
    if (payload.length > 1_500_000) return;
    window.localStorage.setItem(cacheKey, payload);
  } catch {
    // Cache is best-effort. Reports still work without it.
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
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
            Соберите таблицу: строки по менеджерам или группам, столбцы с показателями и формулами.
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

        <section className="builder-flow">
          <div className="builder-step">
            <div className="step-marker">1</div>
            <div className="builder-step-body">
              <div className="step-heading">
                <div>
                  <div className="card-title">Основное</div>
                  <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                    Название, описание и доступ к отчёту.
                  </div>
                </div>
                {draft.mode === 'contract' && <span className="badge badge-blue">Таблица</span>}
                {draft.mode !== 'contract' && <span className="badge badge-yellow">Старый KPI-виджет</span>}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label>
                  <span className="label">Название отчёта</span>
                  <input
                    className="field"
                    value={draft.name}
                    onChange={(event) => onSetDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label className="md:col-span-2">
                  <span className="label">Описание</span>
                  <textarea
                    className="textarea"
                    value={draft.description}
                    onChange={(event) => onSetDraft({ ...draft, description: event.target.value })}
                  />
                </label>
                <div className="md:col-span-2">
                  <MultiCheckbox
                    label="Кому виден отчёт"
                    values={draft.visibleUserIds}
                    options={(options?.appUsers ?? []).map((item) => ({
                      value: item.id,
                      label: `${item.name} (${item.email})`,
                    }))}
                    onChange={(visibleUserIds) => onSetDraft({ ...draft, visibleUserIds })}
                  />
                  <div className="mt-2 text-xs text-[var(--pb-text-secondary)]">
                    Автор и администратор видят отчёт всегда.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {draft.mode === 'contract' ? (
            <>
              <div className="builder-step">
                <div className="step-marker">2</div>
                <div className="builder-step-body">
                  <div className="step-heading">
                    <div>
                      <div className="card-title">Период и строки</div>
                      <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                        Сначала задаём общий период и разрез таблицы.
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4">
                    <label className="max-w-[360px]">
                      <span className="label">Что анализируем</span>
                      <select
                        className="select"
                        value={draft.entity}
                        onChange={(event) => {
                          const entity = event.target.value as ReportDraft['entity'];
                          onSetDraft({
                            ...draft,
                            entity,
                            contractMetrics: entity === 'task' ? getDefaultTaskMetrics() : getDefaultContractMetrics(),
                            contractConversions: [],
                            contractDurations: [],
                          });
                        }}
                      >
                        <option value="deal">Сделки</option>
                        <option value="task">Задачи</option>
                      </select>
                    </label>

                    <PeriodPicker filters={filters} onSetFilters={onSetFilters} />

                    <div className="grid gap-4 md:grid-cols-3">
                      <label>
                        <span className="label">Строки таблицы</span>
                        <select
                          className="select"
                          value={draft.contractGroupBy}
                          onChange={(event) => onSetDraft({ ...draft, contractGroupBy: event.target.value as 'manager' | 'group' | 'none' })}
                        >
                          <option value="manager">Менеджеры</option>
                          <option value="group">Группы менеджеров</option>
                          <option value="none">Только весь отдел</option>
                        </select>
                      </label>
                      <div className="md:col-span-2 grid gap-4 md:grid-cols-2">
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
                      </div>
                    </div>

                    <div className="grid gap-3 rounded-[10px] border border-[var(--pb-border)] bg-white p-4 md:grid-cols-2">
                      <label className="flex items-center gap-3 text-sm font-semibold">
                        <input
                          checked={draft.includeRowTotal}
                          type="checkbox"
                          onChange={(event) => onSetDraft({ ...draft, includeRowTotal: event.target.checked })}
                        />
                        Итог в конце каждой строки
                      </label>
                      <label>
                        <span className="label">Как считать итог строки</span>
                        <select
                          className="select"
                          value={draft.rowTotalMode}
                          onChange={(event) => onSetDraft({ ...draft, rowTotalMode: event.target.value as 'sum' | 'avg' })}
                        >
                          <option value="sum">Сумма</option>
                          <option value="avg">Среднее</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-3 text-sm font-semibold">
                        <input
                          checked={draft.includeSummaryRow}
                          type="checkbox"
                          onChange={(event) => onSetDraft({ ...draft, includeSummaryRow: event.target.checked })}
                        />
                        Итоговая строка внизу таблицы
                      </label>
                      <label>
                        <span className="label">Как считать итог столбца</span>
                        <select
                          className="select"
                          value={draft.summaryRowMode}
                          onChange={(event) => onSetDraft({ ...draft, summaryRowMode: event.target.value as 'sum' | 'avg' })}
                        >
                          <option value="sum">Сумма</option>
                          <option value="avg">Среднее</option>
                        </select>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="builder-step">
                <div className="step-marker">3</div>
                <div className="builder-step-body">
                  <div className="step-heading">
                    <div>
                      <div className="card-title">Показатели</div>
                      <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                        Каждый столбец задаёт свою выборку, расчёт и дополнительные условия.
                      </div>
                    </div>
                  </div>
                  <ContractBuilder draft={draft} onSetDraft={onSetDraft} options={options} />
                </div>
              </div>
            </>
          ) : (
            <div className="builder-step">
              <div className="step-marker">2</div>
              <div className="builder-step-body">
                <div className="step-heading">
                  <div>
                    <div className="card-title">Старый простой виджет</div>
                    <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                      Этот режим оставлен только для редактирования ранее созданных KPI.
                    </div>
                  </div>
                </div>
                <div className="grid gap-5">
                  <PeriodPicker filters={filters} onSetFilters={onSetFilters} />
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
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="builder-step">
            <div className="step-marker">{draft.mode === 'contract' ? '4' : '3'}</div>
            <div className="builder-step-body">
              <div className="step-heading">
                <div>
                  <div className="card-title">Проверка и сохранение</div>
                  <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                    Проверьте отчёт, затем сохраните или закрепите на рабочем столе.
                  </div>
                </div>
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

function PeriodPicker({
  filters,
  onSetFilters,
}: {
  filters: ReportFilters;
  onSetFilters: (filters: ReportFilters) => void;
}) {
  const mode = filters.periodMode ?? 'preset';
  return (
    <section className="grid gap-3 rounded-[10px] border border-[var(--pb-border)] bg-[var(--pb-bg)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="card-title">Период отчёта</div>
          <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
            Период применяется ко всем столбцам, если в показателе не задано отдельное условие.
          </div>
        </div>
        <select
          className="select max-w-[240px]"
          value={mode}
          onChange={(event) => onSetFilters({ ...filters, periodMode: event.target.value as PeriodMode })}
        >
          <option value="preset">Пресет</option>
          <option value="custom">Календарь</option>
          <option value="relative">Относительный период</option>
        </select>
      </div>

      {mode === 'preset' && (
        <div className="grid gap-3 md:grid-cols-3">
          {(Object.keys(periodPresetLabels) as PeriodPreset[]).map((preset) => (
            <button
              key={preset}
              className={`segmented-option ${filters.periodPreset === preset ? 'active' : ''}`}
              type="button"
              onClick={() => onSetFilters({ ...filters, periodMode: 'preset', periodPreset: preset })}
            >
              {periodPresetLabels[preset]}
            </button>
          ))}
        </div>
      )}

      {mode === 'custom' && (
        <div className="grid gap-4 md:grid-cols-2">
          <label>
            <span className="label">Дата с</span>
            <input
              className="field"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={(event) => onSetFilters({ ...filters, periodMode: 'custom', dateFrom: event.target.value })}
            />
          </label>
          <label>
            <span className="label">Дата по</span>
            <input
              className="field"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={(event) => onSetFilters({ ...filters, periodMode: 'custom', dateTo: event.target.value })}
            />
          </label>
        </div>
      )}

      {mode === 'relative' && (
        <div className="grid gap-4 md:grid-cols-[160px_1fr]">
          <label>
            <span className="label">Последние</span>
            <input
              className="field"
              min={1}
              type="number"
              value={filters.relativeAmount ?? 7}
              onChange={(event) => onSetFilters({ ...filters, periodMode: 'relative', relativeAmount: Number(event.target.value) })}
            />
          </label>
          <label>
            <span className="label">Единица</span>
            <select
              className="select"
              value={filters.relativeUnit ?? 'days'}
              onChange={(event) =>
                onSetFilters({
                  ...filters,
                  periodMode: 'relative',
                  relativeUnit: event.target.value as NonNullable<ReportFilters['relativeUnit']>,
                })
              }
            >
              <option value="hours">часов</option>
              <option value="days">дней</option>
              <option value="weeks">недель</option>
              <option value="months">месяцев</option>
            </select>
          </label>
        </div>
      )}
    </section>
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
  const sourceMetrics = draft.contractMetrics.filter((metric) => metric.type !== 'conversion' && metric.type !== 'formula');
  const isTaskReport = draft.entity === 'task';
  const draggingMetricIdRef = useRef<string | null>(null);
  const [draggingMetricId, setDraggingMetricId] = useState<string | null>(null);
  const [metricDropTarget, setMetricDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);

  function patchMetric(id: string, patch: Partial<ContractMetricDraft>) {
    onSetDraft({
      ...draft,
      contractMetrics: draft.contractMetrics.map((metric) =>
        metric.id === id ? { ...metric, ...patch } : metric,
      ),
    });
  }

  function patchMetricFilter(metricId: string, filterId: string, patch: Partial<ContractFilterDraft>) {
    onSetDraft({
      ...draft,
      contractMetrics: draft.contractMetrics.map((metric) =>
        metric.id === metricId
          ? {
              ...metric,
              extraFilters: metric.extraFilters.map((filter) =>
                filter.id === filterId ? { ...filter, ...patch } : filter,
              ),
            }
          : metric,
      ),
    });
  }

  function addMetricFilter(metricId: string) {
    onSetDraft({
      ...draft,
      contractMetrics: draft.contractMetrics.map((metric) =>
        metric.id === metricId
          ? {
              ...metric,
              extraFilters: [
                ...metric.extraFilters,
                metric.type === 'task_count' ? createTaskFilter('task_type', '') : createContractFilter(),
              ],
            }
          : metric,
      ),
    });
  }

  function removeMetricFilter(metricId: string, filterId: string) {
    onSetDraft({
      ...draft,
      contractMetrics: draft.contractMetrics.map((metric) =>
        metric.id === metricId
          ? { ...metric, extraFilters: metric.extraFilters.filter((filter) => filter.id !== filterId) }
          : metric,
      ),
    });
  }

  function moveMetric(sourceId: string, targetId: string, position: 'before' | 'after') {
    if (sourceId === targetId) return;

    const sourceIndex = draft.contractMetrics.findIndex((metric) => metric.id === sourceId);
    const targetIndex = draft.contractMetrics.findIndex((metric) => metric.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const nextMetrics = [...draft.contractMetrics];
    const [sourceMetric] = nextMetrics.splice(sourceIndex, 1);
    let insertIndex = targetIndex + (position === 'after' ? 1 : 0);
    if (sourceIndex < insertIndex) insertIndex -= 1;
    nextMetrics.splice(insertIndex, 0, sourceMetric);

    onSetDraft({
      ...draft,
      contractMetrics: nextMetrics,
    });
  }

  function moveMetricByStep(metricId: string, direction: -1 | 1) {
    const currentIndex = draft.contractMetrics.findIndex((metric) => metric.id === metricId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= draft.contractMetrics.length) return;

    const nextMetrics = [...draft.contractMetrics];
    [nextMetrics[currentIndex], nextMetrics[targetIndex]] = [nextMetrics[targetIndex], nextMetrics[currentIndex]];
    onSetDraft({
      ...draft,
      contractMetrics: nextMetrics,
    });
  }

  function startMetricDrag(metricId: string) {
    draggingMetricIdRef.current = metricId;
    setDraggingMetricId(metricId);
    setMetricDropTarget(null);
  }

  function getMetricDropTargetFromPoint(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY);
    const card = element?.closest<HTMLElement>('[data-metric-id]');
    const id = card?.dataset.metricId;
    if (!card || !id) return null;

    const bounds = card.getBoundingClientRect();
    return {
      id,
      position: clientY > bounds.top + bounds.height / 2 ? 'after' as const : 'before' as const,
    };
  }

  function handleMetricPointerDown(event: ReactPointerEvent<HTMLButtonElement>, metricId: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    startMetricDrag(metricId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleMetricPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const sourceId = draggingMetricIdRef.current;
    if (!sourceId) return;
    event.preventDefault();

    const target = getMetricDropTargetFromPoint(event.clientX, event.clientY);
    setMetricDropTarget(target && target.id !== sourceId ? target : null);
  }

  function handleMetricPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const sourceId = draggingMetricIdRef.current;
    if (!sourceId) return;
    event.preventDefault();

    const target = getMetricDropTargetFromPoint(event.clientX, event.clientY) ?? metricDropTarget;
    if (target && target.id !== sourceId) {
      moveMetric(sourceId, target.id, target.position);
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    clearMetricDragState();
  }

  function handleMetricMouseDown(event: ReactMouseEvent<HTMLButtonElement>, metricId: string) {
    if (event.button !== 0 || draggingMetricIdRef.current) return;
    event.preventDefault();
    startMetricDrag(metricId);
  }

  function clearMetricDragState() {
    draggingMetricIdRef.current = null;
    setDraggingMetricId(null);
    setMetricDropTarget(null);
  }

  useEffect(() => {
    if (!draggingMetricId) return;

    function handleMouseMove(event: MouseEvent) {
      const sourceId = draggingMetricIdRef.current;
      if (!sourceId) return;

      const target = getMetricDropTargetFromPoint(event.clientX, event.clientY);
      setMetricDropTarget(target && target.id !== sourceId ? target : null);
    }

    function handleMouseUp(event: MouseEvent) {
      const sourceId = draggingMetricIdRef.current;
      if (!sourceId) return;

      const target = getMetricDropTargetFromPoint(event.clientX, event.clientY) ?? metricDropTarget;
      if (target && target.id !== sourceId) {
        moveMetric(sourceId, target.id, target.position);
      }
      clearMetricDragState();
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingMetricId, metricDropTarget, draft]);

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
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="card-title">Показатели отчёта</div>
            <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
              Каждый показатель сам задаёт выборку данных, операцию расчёта и допустимый формат вывода.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {isTaskReport ? (
              <button
                className="btn"
                type="button"
                onClick={() =>
                  onSetDraft({
                    ...draft,
                    contractMetrics: [...draft.contractMetrics, createTaskMetric('Новый показатель задач')],
                  })
                }
              >
                <Plus size={15} />
                Добавить показатель задач
              </button>
            ) : (
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
            )}
            {!isTaskReport && (
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
            )}
            <button
              className="btn"
              type="button"
              onClick={() =>
                onSetDraft({
                  ...draft,
                  contractMetrics: [
                    ...draft.contractMetrics,
                    {
                      ...createContractMetric('Формула', 'formula'),
                      formula: sourceMetrics[0] ? `[${sourceMetrics[0].label}]` : '',
                    },
                  ],
                })
              }
            >
              <Plus size={15} />
              Добавить формулу
            </button>
          </div>
        </div>

        {draft.contractMetrics.map((metric, index) => {
          const dropClass =
            metricDropTarget?.id === metric.id ? `drop-${metricDropTarget.position}` : '';

          return (
          <div
            key={metric.id}
            data-metric-id={metric.id}
            className={`metric-card ${draggingMetricId === metric.id ? 'dragging' : ''} ${dropClass}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  aria-label="Переместить показатель"
                  className="metric-drag-handle"
                  title="Переместить показатель"
                  type="button"
                  onMouseDown={(event) => handleMetricMouseDown(event, metric.id)}
                  onPointerCancel={clearMetricDragState}
                  onPointerDown={(event) => handleMetricPointerDown(event, metric.id)}
                  onPointerMove={handleMetricPointerMove}
                  onPointerUp={handleMetricPointerUp}
                >
                  <GripVertical size={16} />
                </button>
                <button
                  aria-label="Выше"
                  className="icon-btn metric-order-btn"
                  disabled={index === 0}
                  title="Выше"
                  type="button"
                  onClick={() => moveMetricByStep(metric.id, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  aria-label="Ниже"
                  className="icon-btn metric-order-btn"
                  disabled={index === draft.contractMetrics.length - 1}
                  title="Ниже"
                  type="button"
                  onClick={() => moveMetricByStep(metric.id, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <span className="badge badge-blue">#{index + 1}</span>
              </div>
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
              {metric.type === 'task_count' ? (
                <div>
                  <span className="label">Что считать</span>
                  <div className="condition-strip">
                    <span className="badge badge-blue">Количество задач</span>
                  </div>
                </div>
              ) : (
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
                    <option value="formula">Формулу по другим показателям</option>
                  </select>
                </label>
              )}
            </div>

            {metric.type === 'formula' ? (
              <div className="grid gap-4">
                <label>
                  <span className="label">Формула</span>
                  <input
                    className="field"
                    value={metric.formula}
                    onChange={(event) => patchMetric(metric.id, { formula: event.target.value })}
                    placeholder="[Лиды] / [КП отправлены] * 100"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {sourceMetrics.map((item) => (
                    <button
                      key={item.id}
                      className="btn"
                      type="button"
                      onClick={() => patchMetric(metric.id, { formula: `${metric.formula}${metric.formula ? ' ' : ''}[${item.label}]` })}
                    >
                      Вставить: {item.label}
                    </button>
                  ))}
                </div>
                <label className="max-w-[220px]">
                  <span className="label">Формат</span>
                  <select
                    className="select"
                    value={metric.display}
                    onChange={(event) => patchMetric(metric.id, { display: event.target.value as ContractDisplay })}
                  >
                    <option value="number">Число</option>
                    <option value="money">Деньги</option>
                    <option value="percent">Процент</option>
                  </select>
                </label>
              </div>
            ) : metric.type === 'task_count' ? (
              <div className="grid gap-4">
                <div className="condition-strip">
                  <span className="badge badge-blue">Задачи</span>
                  <span className="text-sm text-[var(--pb-text-secondary)]">
                    Считаем количество задач. Типы и статусы задаются через дополнительные условия.
                  </span>
                </div>
                <MetricExtraFilters
                  allStages={allStages}
                  dealFieldOptions={dealFieldOptions}
                  entity="task"
                  filters={metric.extraFilters}
                  groups={options?.groups ?? []}
                  managers={options?.managers ?? []}
                  taskTypes={options?.taskTypes ?? []}
                  onAdd={() => addMetricFilter(metric.id)}
                  onPatch={(filterId, patch) => patchMetricFilter(metric.id, filterId, patch)}
                  onRemove={(filterId) => removeMetricFilter(metric.id, filterId)}
                />
              </div>
            ) : metric.type === 'conversion' ? (
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

                <MetricExtraFilters
                  allStages={allStages}
                  dealFieldOptions={dealFieldOptions}
                  entity="deal"
                  filters={metric.extraFilters}
                  groups={options?.groups ?? []}
                  managers={options?.managers ?? []}
                  taskTypes={options?.taskTypes ?? []}
                  onAdd={() => addMetricFilter(metric.id)}
                  onPatch={(filterId, patch) => patchMetricFilter(metric.id, filterId, patch)}
                  onRemove={(filterId) => removeMetricFilter(metric.id, filterId)}
                />
              </div>
            )}
          </div>
          );
        })}
      </section>

      {!isTaskReport && <section className="grid gap-3">
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
      </section>}
    </div>
  );
}

function MetricExtraFilters({
  allStages,
  dealFieldOptions,
  entity,
  filters,
  groups,
  managers,
  taskTypes,
  onAdd,
  onPatch,
  onRemove,
}: {
  allStages: FieldOption[];
  dealFieldOptions: FieldOption[];
  entity: 'deal' | 'task';
  filters: ContractFilterDraft[];
  groups: Group[];
  managers: Manager[];
  taskTypes: Array<{ id: string; name: string }>;
  onAdd: () => void;
  onPatch: (filterId: string, patch: Partial<ContractFilterDraft>) => void;
  onRemove: (filterId: string) => void;
}) {
  return (
    <div className="grid gap-4 rounded-[10px] border border-[var(--pb-border)] bg-[var(--pb-bg)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="card-title">Дополнительные условия</div>
          <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
            Все условия применяются одновременно: условие 1 + условие 2 + условие 3.
          </div>
        </div>
        <button className="btn" type="button" onClick={onAdd}>
          <Plus size={15} />
          Добавить условие
        </button>
      </div>

      {filters.length === 0 ? (
        <div className="muted text-sm">Дополнительных условий нет.</div>
      ) : (
        <div className="grid gap-3">
          {filters.map((filter, index) => {
            const operators = operatorsForSubject(filter.subject);
            return (
              <div key={filter.id} className="grid gap-3 rounded-[10px] border border-[var(--pb-border)] bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="badge badge-blue">Условие {index + 1}</span>
                  <button className="btn btn-danger" type="button" onClick={() => onRemove(filter.id)}>
                    <Trash2 size={14} />
                    Удалить
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <label>
                    <span className="label">Данные</span>
                    <select
                      className="select"
                      value={filter.subject}
                      onChange={(event) => {
                        const subject = event.target.value as ContractFilterSubject;
                        onPatch(filter.id, {
                          subject,
                          fieldId: '',
                          operator: defaultOperatorForSubject(subject),
                          value: '',
                          amount: 1,
                          unit: subject === 'last_note_created_at' ? 'hours' : 'days',
                        });
                      }}
                    >
                      {filterSubjectsForEntity(entity).map((subject) => (
                        <option key={subject} value={subject}>
                          {filterSubjectLabels[subject]}
                        </option>
                      ))}
                    </select>
                  </label>

                  {filter.subject === 'deal_field' && (
                    <label>
                      <span className="label">Поле amoCRM</span>
                      <select
                        className="select"
                        value={filter.fieldId}
                        onChange={(event) => onPatch(filter.id, { fieldId: event.target.value })}
                      >
                        <option value="">Выберите поле</option>
                        {dealFieldOptions.map((field) => (
                          <option key={field.value} value={field.value}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label>
                    <span className="label">Условие</span>
                    <select
                      className="select"
                      value={filter.operator}
                      onChange={(event) => onPatch(filter.id, { operator: event.target.value as ContractFilterOperator })}
                    >
                      {operators.map((operator) => (
                        <option key={operator} value={operator}>
                          {filterOperatorLabels[operator]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <FilterValueControl
                    allStages={allStages}
                    filter={filter}
                    groups={groups}
                    managers={managers}
                    taskTypes={taskTypes}
                    onPatch={(patch) => onPatch(filter.id, patch)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterValueControl({
  allStages,
  filter,
  groups,
  managers,
  taskTypes,
  onPatch,
}: {
  allStages: FieldOption[];
  filter: ContractFilterDraft;
  groups: Group[];
  managers: Manager[];
  taskTypes: Array<{ id: string; name: string }>;
  onPatch: (patch: Partial<ContractFilterDraft>) => void;
}) {
  if (filter.operator === 'is_set') return null;

  if (filter.operator === 'within_last' || filter.operator === 'older_than') {
    return (
      <div className="grid gap-3 md:col-span-1 md:grid-cols-[1fr_140px]">
        <label>
          <span className="label">Количество</span>
          <input
            className="field"
            min={1}
            type="number"
            value={filter.amount}
            onChange={(event) => onPatch({ amount: Math.max(1, Number(event.target.value)) })}
          />
        </label>
        <label>
          <span className="label">Единица</span>
          <select className="select" value={filter.unit} onChange={(event) => onPatch({ unit: event.target.value as RelativeUnit })}>
            {(Object.keys(relativeUnitLabels) as RelativeUnit[]).map((unit) => (
              <option key={unit} value={unit}>
                {relativeUnitLabels[unit]}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (filter.subject === 'deal_stage') {
    return (
      <label>
        <span className="label">Значение</span>
        <select className="select" value={filter.value} onChange={(event) => onPatch({ value: event.target.value })}>
          <option value="">Выберите этап</option>
          {allStages.map((stage) => (
            <option key={stage.value} value={stage.value}>
              {stage.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (filter.subject === 'task_type') {
    return (
      <label>
        <span className="label">Значение</span>
        <select className="select" value={filter.value} onChange={(event) => onPatch({ value: event.target.value })}>
          <option value="">Выберите тип задачи</option>
          {taskTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (filter.subject === 'task_status') {
    return (
      <label>
        <span className="label">Значение</span>
        <select className="select" value={filter.value} onChange={(event) => onPatch({ value: event.target.value })}>
          <option value="">Выберите статус</option>
          {Object.entries(taskStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (filter.subject === 'deal_responsible' || filter.subject === 'task_responsible') {
    return (
      <label>
        <span className="label">Значение</span>
        <select className="select" value={filter.value} onChange={(event) => onPatch({ value: event.target.value })}>
          <option value="">Выберите менеджера</option>
          {managers.map((manager) => (
            <option key={manager.id} value={manager.id}>
              {manager.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (filter.subject === 'deal_group' || filter.subject === 'task_group') {
    return (
      <label>
        <span className="label">Значение</span>
        <select className="select" value={filter.value} onChange={(event) => onPatch({ value: event.target.value })}>
          <option value="">Выберите группу</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label>
      <span className="label">Значение</span>
      <input
        className="field"
        type={filter.subject === 'deal_amount' ? 'number' : 'text'}
        value={filter.value}
        onChange={(event) => onPatch({ value: event.target.value })}
        placeholder={filter.subject === 'deal_amount' ? 'Например: 100000' : 'Введите значение'}
      />
    </label>
  );
}

function filterSubjectsForEntity(entity: 'deal' | 'task'): ContractFilterSubject[] {
  if (entity === 'task') {
    return [
      'task_type',
      'task_status',
      'task_due_at',
      'task_created_at',
      'task_updated_at',
      'task_completed_at',
      'task_text',
      'task_responsible',
      'task_group',
    ];
  }
  return [
    'deal_created_at',
    'deal_updated_at',
    'deal_closed_at',
    'deal_expected_close_at',
    'deal_amount',
    'deal_stage',
    'deal_responsible',
    'deal_group',
    'deal_field',
    'last_note_created_at',
    'last_note_text',
  ];
}

function operatorsForSubject(subject: ContractFilterSubject): ContractFilterOperator[] {
  if ([
    'deal_created_at',
    'deal_updated_at',
    'deal_closed_at',
    'deal_expected_close_at',
    'last_note_created_at',
    'task_created_at',
    'task_updated_at',
    'task_due_at',
    'task_completed_at',
  ].includes(subject)) {
    return ['within_last', 'older_than', 'is_set'];
  }
  if (subject === 'deal_amount') return ['gt', 'gte', 'lt', 'lte', 'equals'];
  if (subject === 'last_note_text' || subject === 'task_text') return ['contains', 'equals', 'is_set'];
  if (subject === 'deal_field') return ['equals', 'contains', 'is_set', 'lt', 'lte', 'gt', 'gte'];
  return ['equals', 'is_set'];
}

function defaultOperatorForSubject(subject: ContractFilterSubject): ContractFilterOperator {
  if ([
    'deal_created_at',
    'deal_updated_at',
    'deal_closed_at',
    'deal_expected_close_at',
    'last_note_created_at',
    'task_created_at',
    'task_updated_at',
    'task_due_at',
    'task_completed_at',
  ].includes(subject)) {
    return 'within_last';
  }
  if (subject === 'deal_amount') return 'gte';
  if (subject === 'last_note_text' || subject === 'task_text') return 'contains';
  return 'equals';
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

function PlanFactTab({ refreshStamp }: { refreshStamp: number }) {
  const [month, setMonth] = useState(currentMonthInput());
  const [report, setReport] = useState<PlanFactReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [dirtyCount, setDirtyCount] = useState(0);
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const reportRef = useRef<PlanFactReport | null>(null);

  const load = useCallback(async (preserveDrafts = false) => {
    setLoading(true);
    setError('');
    try {
      const next = await api<PlanFactReport>(`/platform/plans/fact?month=${encodeURIComponent(month)}`);
      setReport(next);
      reportRef.current = next;
      const nextDrafts = planFactDrafts(next);
      setDrafts((current) => {
        if (!preserveDrafts || dirtyKeysRef.current.size === 0) return nextDrafts;
        const merged = { ...nextDrafts };
        for (const key of dirtyKeysRef.current) {
          if (current[key] !== undefined) merged[key] = current[key];
        }
        return merged;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить план-факт');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    dirtyKeysRef.current = new Set();
    setDirtyCount(0);
    setSaveState('idle');
    setSaveError('');
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!reportRef.current) return;
    void load(true);
  }, [refreshStamp, load]);

  function updatePlanDraft(key: string, value: string) {
    dirtyKeysRef.current.add(key);
    setDirtyCount(dirtyKeysRef.current.size);
    setDrafts((current) => ({ ...current, [key]: value }));
    setSaveState('dirty');
    setSaveError('');
  }

  async function savePlanChanges() {
    const currentReport = reportRef.current ?? report;
    const dirtyKeys = Array.from(dirtyKeysRef.current);
    if (!currentReport || dirtyKeys.length === 0) return;

    const entries = resolvePlanFactSaveEntries(currentReport, dirtyKeys, drafts);
    if (!entries.length) return;

    setSaveState('saving');
    setSaveError('');
    try {
      for (const entry of entries) {
        await api('/platform/plans/fact', {
          method: 'PATCH',
          body: JSON.stringify({
            month,
            planSetId: currentReport.planSet?.id,
            teamKey: entry.teamKey,
            metricKey: entry.metricKey,
            targetType: entry.targetType,
            targetId: entry.targetId,
            value: entry.value,
          }),
        });
      }
      dirtyKeysRef.current = new Set();
      setDirtyCount(0);
      setSaveState('saved');
      await load(false);
    } catch (err) {
      setSaveState('error');
      setSaveError(readApiError(err, 'Планы не сохранены'));
    }
  }

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">План-факт</h1>
          <p className="page-description">
            План к дате считается по рабочим дням месяца. Дневной план повышается при отставании и не снижается при перевыполнении.
          </p>
        </div>
        <div className="plan-fact-actions">
          <label className="plan-fact-month">
            <span className="label">Месяц</span>
            <input className="field" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <button className="btn btn-secondary" type="button" onClick={() => setEditorOpen((current) => !current)}>
            {editorOpen ? 'Скрыть планы' : 'Планы'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-red">
          <AlertCircle size={17} />
          <span>{error}</span>
        </div>
      )}

      {report?.warnings?.length ? (
        <div className="alert alert-yellow">
          <AlertCircle size={17} />
          <span>{report.warnings.join(' ')}</span>
        </div>
      ) : null}

      {editorOpen && report && (
        <section className="card plan-fact-editor">
          <div className="plan-fact-editor-head">
            <div>
              <div className="card-title">Планы на месяц</div>
              <p className="m-0 text-sm text-[var(--pb-text-secondary)]">
                Пустое поле удаляет план по этой метрике.
              </p>
            </div>
            <div className="plan-fact-editor-actions">
              {saveState !== 'idle' && <span className={`plan-fact-save ${saveState}`}>{planFactSaveLabel(saveState)}</span>}
              <button
                className="btn btn-primary"
                type="button"
                disabled={saveState === 'saving' || dirtyCount === 0}
                onClick={() => void savePlanChanges()}
              >
                <Save size={15} />
                Сохранить
              </button>
            </div>
          </div>
          {saveError && (
            <div className="alert alert-red">
              <AlertCircle size={17} />
              <span>{saveError}</span>
            </div>
          )}
          {report.teams.map((team) => (
            <PlanFactPlanEditor
              key={team.key}
              drafts={drafts}
              team={team}
              onDraftChange={updatePlanDraft}
            />
          ))}
        </section>
      )}

      {loading && !report ? (
        <div className="card p-5 text-sm text-[var(--pb-text-secondary)]">Считаю план-факт...</div>
      ) : report?.teams.length ? (
        <div className="dashboard-sections">
          <PlanFactReportGroup
            mode="day"
            title="План-факт за день"
            description="Факт сегодня против плана на сегодня"
            teams={report.teams}
          />
          <PlanFactReportGroup
            mode="uptodate"
            title="Up-to-date"
            description="Факт с начала месяца против плана к текущей дате"
            teams={report.teams}
          />
        </div>
      ) : (
        <div className="empty-state">
          <div>
            <h2 className="mt-0 text-lg font-bold">Нет данных для план-факта</h2>
            <p className="mt-2 text-sm text-[var(--pb-text-secondary)]">
              Проверь группы продаж и CSM, а также этапы в amoCRM.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

type PlanFactViewMode = 'day' | 'uptodate';

function PlanFactReportGroup({
  description,
  mode,
  teams,
  title,
}: {
  description: string;
  mode: PlanFactViewMode;
  teams: PlanFactTeam[];
  title: string;
}) {
  return (
    <section className="plan-fact-report-group">
      <div className="dashboard-section-header static">
        <span className="dashboard-section-title">{title}</span>
        <span className="dashboard-section-count">{description}</span>
      </div>
      {teams.map((team) => (
        <PlanFactTeamSection key={`${mode}-${team.key}`} mode={mode} team={team} />
      ))}
    </section>
  );
}

function PlanFactTeamSection({ mode, team }: { mode: PlanFactViewMode; team: PlanFactTeam }) {
  const columns = [team.total, ...team.rows];
  return (
    <section className="dashboard-section">
      <div className="dashboard-section-header static">
        <span className="dashboard-section-title">{team.name}</span>
        <span className="dashboard-section-count">{formatNumber(team.rows.length)} менеджеров</span>
      </div>
      <div className="plan-fact-table-wrap">
        <table className="plan-fact-table">
          <thead>
            <tr>
              <th>Метрика</th>
              {columns.map((row) => (
                <th key={`${row.targetType}-${row.targetId}`}>{row.targetName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {team.metrics.map((metric) => (
              <tr key={metric.key}>
                <th>{metric.label}</th>
                {columns.map((row) => (
                  <td key={`${row.targetType}-${row.targetId}-${metric.key}`}>
                    <PlanFactCellView cell={row.values[metric.key]} metric={metric} mode={mode} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlanFactCellView({ cell, metric, mode }: { cell?: PlanFactCell; metric: PlanFactMetric; mode: PlanFactViewMode }) {
  if (!cell) return <span className="muted">-</span>;
  const fact = mode === 'day' ? cell.factToday : cell.factMonth;
  const plan = mode === 'day' ? cell.todayPlan : cell.upToDatePlan;
  const delta = mode === 'day' ? cell.todayDelta : cell.monthDelta;
  const periodLabel = mode === 'day' ? 'Сегодня' : 'К дате';
  const tone = delta == null ? 'neutral' : delta >= 0 ? 'positive' : 'negative';
  const title = [
    `${periodLabel}. Факт: ${formatPlanFactValue(fact, metric.unit)}`,
    plan == null ? `${periodLabel}. План не задан` : `${periodLabel}. План: ${formatPlanFactValue(plan, metric.unit)}`,
    cell.plan == null ? null : `План месяца: ${formatPlanFactValue(cell.plan, metric.unit)}`,
  ].filter(Boolean).join('\n');
  return (
    <div className={`plan-fact-cell ${tone}`} title={title}>
      <div className="plan-fact-delta">{formatPlanFactDelta(delta, metric.unit)}</div>
      <div className="plan-fact-main">
        <span>Факт</span>
        <strong>{formatPlanFactValue(fact, metric.unit)}</strong>
        {plan == null ? null : <span>из {formatPlanFactValue(plan, metric.unit)}</span>}
      </div>
    </div>
  );
}

function PlanFactPlanEditor({
  drafts,
  onDraftChange,
  team,
}: {
  drafts: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
  team: PlanFactTeam;
}) {
  const columns = [team.total, ...team.rows];
  return (
    <div className="plan-fact-editor-team">
      <div className="section-subtitle">{team.name}</div>
      <div className="plan-fact-table-wrap">
        <table className="plan-fact-plan-table">
          <thead>
            <tr>
              <th>Метрика</th>
              {columns.map((row) => (
                <th key={`${team.key}-${row.targetType}-${row.targetId}`}>{row.targetName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {team.metrics.map((metric) => (
              <tr key={`${team.key}-${metric.key}`}>
                <th>{metric.label}</th>
                {columns.map((row) => {
                  const key = planFactInputKey(team.key, row, metric.key);
                  const isSharedConversionCell = metric.kind === 'conversion' && row.targetType !== 'GROUP';
                  return (
                    <td key={key}>
                      {isSharedConversionCell ? (
                        <span className="plan-fact-shared-plan">как в отделе</span>
                      ) : (
                        <input
                          className="field plan-fact-plan-input"
                          inputMode={metric.unit === 'number' ? 'numeric' : 'decimal'}
                          value={drafts[key] ?? ''}
                          onChange={(event) => onDraftChange(key, event.target.value)}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function planFactDrafts(report: PlanFactReport) {
  const result: Record<string, string> = {};
  for (const team of report.teams) {
    for (const row of [team.total, ...team.rows]) {
      for (const metric of team.metrics) {
        const key = planFactInputKey(team.key, row, metric.key);
        const value = row.values[metric.key]?.plan;
        result[key] = value == null ? '' : String(value);
      }
    }
  }
  return result;
}

function planFactInputKey(teamKey: string, row: PlanFactTargetRow, metricKey: string) {
  return `${teamKey}:${row.targetType}:${row.targetId}:${metricKey}`;
}

function readApiError(err: unknown, fallback: string) {
  const text = err instanceof Error ? err.message : String(err ?? '');
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { message?: string | string[]; error?: string };
    if (Array.isArray(parsed.message)) return parsed.message.join(' ');
    return parsed.message || parsed.error || fallback;
  } catch {
    return text;
  }
}

function resolvePlanFactSaveEntries(report: PlanFactReport, keys: string[], drafts: Record<string, string>) {
  const entries: Array<{
    key: string;
    teamKey: PlanFactTeam['key'];
    metricKey: string;
    targetType: PlanFactTargetRow['targetType'];
    targetId: string;
    value: string;
  }> = [];
  for (const team of report.teams) {
    const rows = [team.total, ...team.rows];
    for (const row of rows) {
      for (const metric of team.metrics) {
        const key = planFactInputKey(team.key, row, metric.key);
        if (!keys.includes(key)) continue;
        if (metric.kind === 'conversion' && row.targetType !== 'GROUP') continue;
        entries.push({
          key,
          teamKey: team.key,
          metricKey: metric.key,
          targetType: row.targetType,
          targetId: row.targetId,
          value: drafts[key] ?? '',
        });
      }
    }
  }
  return entries;
}

function formatPlanFactDelta(value: number | null | undefined, unit: PlanFactMetric['unit']) {
  if (value === null || value === undefined) return 'план не задан';
  const prefix = value > 0 ? '+' : '';
  if (unit === 'percent') return `${prefix}${formatNumber(value)} п.п.`;
  return `${prefix}${formatPlanFactValue(value, unit)}`;
}

function formatPlanFactValue(value: number | null | undefined, unit: PlanFactMetric['unit']) {
  if (value === null || value === undefined) return '-';
  if (unit === 'number') return formatNumber(Math.ceil(Number(value)));
  return formatMetricValue(value, unit);
}

function planFactSaveLabel(state: 'dirty' | 'saving' | 'saved' | 'error') {
  if (state === 'dirty') return 'есть несохранённые изменения';
  if (state === 'saving') return 'сохраняю';
  if (state === 'saved') return 'сохранено';
  return 'ошибка';
}

function currentMonthInput() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function LeadSlaTab() {
  const [data, setData] = useState<LeadSlaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const next = await api<LeadSlaResponse>('/platform/lead-sla');
      setData(next);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить SLA лидов');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const cards = data?.cards ?? [];

  return (
    <section className="grid gap-4">
      <div className="page-head">
        <div>
          <h1 className="page-title">SLA лидов</h1>
        </div>
      </div>

      {error && <div className="alert alert-error"><AlertCircle size={17} />{error}</div>}
      {data?.warning && <div className="alert"><AlertCircle size={17} />{data.warning}</div>}

      {loading && !data ? (
        <div className="card p-5 text-sm text-[var(--pb-text-secondary)]">Загрузка лидов...</div>
      ) : cards.length === 0 ? (
        <div className="empty-state">
          <Clock3 size={24} />
          <div>
            <strong>Активных лидов по SLA нет</strong>
            <span>Сейчас нет сделок воронки продаж на этапе “Назначен ответственный”.</span>
          </div>
        </div>
      ) : (
        <div className="lead-sla-grid">
          {cards.map((card) => {
            const runtime = leadSlaRuntime(card, nowMs);
            return (
            <article key={card.dealId} className={`lead-sla-card lead-sla-${runtime.status}`}>
              <div className="lead-sla-card-head">
                <div className="min-w-0">
                  <a className="lead-sla-title" href={card.dealUrl} target="_blank" rel="noreferrer" title={card.title}>
                    {card.title}
                  </a>
                  <div className="lead-sla-meta">{card.pipelineName} · {card.stageName}</div>
                </div>
                <span className={`lead-sla-badge lead-sla-badge-${runtime.status}`}>{runtime.statusLabel}</span>
              </div>

              <div className="lead-sla-timer">
                <span>{formatSlaClock(runtime.elapsedSeconds)}</span>
                <small>из {formatSlaClock(runtime.totalSeconds)}</small>
              </div>

              <div className="lead-sla-progress" aria-label={`SLA ${runtime.progressPercent}%`}>
                <div style={{ width: `${runtime.progressPercent}%` }} />
              </div>

              <div className="lead-sla-info">
                <InfoRow label="Менеджер" value={card.managerName} />
                <InfoRow label="Поступил" value={formatMoscowDateTime(card.createdAt)} />
                <InfoRow label="Старт SLA" value={formatMoscowDateTime(card.startAt)} />
                <InfoRow label="Дедлайн" value={formatMoscowDateTime(card.dueAt)} />
              </div>
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EmailThreadsTab({ onMessage }: { onMessage: (message: string) => void }) {
  const [data, setData] = useState<PendingEmailThreadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<EmailPipelineKey>('sales');
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [selectedManagerKeys, setSelectedManagerKeys] = useState<string[]>([]);
  const [closingId, setClosingId] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const next = await api<PendingEmailThreadsResponse>('/platform/email-threads/pending');
      setData(next);
      setError('');
    } catch (err) {
      setError(readApiError(err, 'Не удалось загрузить письма'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => (data ? normalizeEmailThreadGroups(data) : []), [data]);
  const activeGroup = groups.find((group) => group.key === activeGroupKey) ?? groups[0] ?? null;
  const activeGroupThreads = activeGroup?.threads ?? [];
  const managerFilters = useMemo(() => buildEmailManagerFilters(activeGroupThreads), [activeGroupThreads]);
  const threads = useMemo(
    () => selectedManagerKeys.length
      ? activeGroupThreads.filter((thread) => selectedManagerKeys.includes(emailManagerKey(thread)))
      : activeGroupThreads,
    [activeGroupThreads, selectedManagerKeys],
  );
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? threads[0] ?? null,
    [threads, selectedThreadId],
  );

  useEffect(() => {
    const availableKeys = new Set(managerFilters.map((manager) => manager.key));
    setSelectedManagerKeys((current) => {
      const next = current.filter((key) => availableKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [managerFilters]);

  useEffect(() => {
    if (!threads.length) {
      if (selectedThreadId) setSelectedThreadId('');
      return;
    }
    if (!threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(threads[0].id);
    }
  }, [threads, selectedThreadId]);

  async function dismissThread(thread: PendingEmailThread) {
    setClosingId(thread.id);
    try {
      await api('/platform/email-threads/dismiss', {
        method: 'POST',
        body: JSON.stringify({
          dealId: thread.dealId,
          threadId: thread.threadId,
          lastIncomingNoteExternalId: thread.lastIncomingNoteExternalId,
        }),
      });
      onMessage('Письмо скрыто: ответ не нужен');
      await load();
    } catch (err) {
      setError(readApiError(err, 'Не удалось скрыть письмо'));
    } finally {
      setClosingId('');
    }
  }

  return (
    <section className="grid gap-4">
      <div className="page-row">
        <div>
          <h1 className="page-title">Письма без ответа</h1>
        </div>
        <button className="btn" type="button" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} />
          Обновить
        </button>
      </div>

      {error && <div className="alert alert-error"><AlertCircle size={17} />{error}</div>}

      {data && (
        <div className="email-watch-tabs" role="tablist" aria-label="Воронка писем">
          {groups.map((group) => (
            <button
              key={group.key}
              className={`email-watch-tab ${group.key === activeGroup?.key ? 'active' : ''}`}
              type="button"
              role="tab"
              aria-selected={group.key === activeGroup?.key}
              onClick={() => setActiveGroupKey(group.key)}
            >
              <span>{group.label}</span>
              <strong>{group.summary.total}</strong>
            </button>
          ))}
        </div>
      )}

      {data && activeGroupThreads.length > 0 && (
        <EmailManagerFilter
          managers={managerFilters}
          selectedKeys={selectedManagerKeys}
          total={activeGroupThreads.length}
          visibleTotal={threads.length}
          onChange={setSelectedManagerKeys}
        />
      )}

      {loading && !data ? (
        <div className="card p-5 text-sm text-[var(--pb-text-secondary)]">Загрузка писем...</div>
      ) : activeGroupThreads.length === 0 ? (
        <div className="empty-state">
          <Mail size={24} />
          <div>
            <strong>В этой воронке нет писем без ответа</strong>
            <span>Входящие письма закрыты ответом или пометкой РОПа.</span>
          </div>
        </div>
      ) : threads.length === 0 ? (
        <div className="empty-state">
          <Filter size={24} />
          <div>
            <strong>По выбранным менеджерам писем нет</strong>
            <span>Сбросьте фильтр или выберите другого менеджера.</span>
          </div>
        </div>
      ) : (
        <div className="email-watch-layout">
          <aside className="email-watch-list" aria-label="Письма без ответа">
            {threads.map((thread) => {
              const waitingSeconds = emailWaitingSeconds(thread, nowMs);
              return (
                <button
                  key={thread.id}
                  className={`email-watch-item ${selectedThread?.id === thread.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => setSelectedThreadId(thread.id)}
                >
                  <span className="email-watch-item-head">
                    <strong>{thread.title}</strong>
                    <span>{formatEmailWait(waitingSeconds)}</span>
                  </span>
                  <span className="email-watch-item-meta">{thread.managerName} · {thread.stageName}</span>
                  <span className="email-watch-item-subject">{thread.subject || 'Без темы'}</span>
                </button>
              );
            })}
          </aside>

          {selectedThread && (
            <article className="email-thread-panel">
              <div className="email-thread-head">
                <div className="min-w-0">
                  <a className="email-thread-title" href={selectedThread.dealUrl} target="_blank" rel="noreferrer">
                    {selectedThread.title}
                  </a>
                  <div className="email-thread-meta">{selectedThread.pipelineName} · {selectedThread.stageName}</div>
                </div>
                <div className="email-thread-actions">
                  <a className="btn" href={selectedThread.dealUrl} target="_blank" rel="noreferrer">
                    Открыть amoCRM
                  </a>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={closingId === selectedThread.id}
                    onClick={() => void dismissThread(selectedThread)}
                  >
                    <CheckCircle2 size={15} />
                    Ответ не нужен
                  </button>
                </div>
              </div>

              <div className="email-thread-info">
                <InfoRow label="Без ответа" value={formatEmailWait(emailWaitingSeconds(selectedThread, nowMs))} />
                <InfoRow label="Последнее письмо" value={formatMoscowDateTime(selectedThread.lastIncomingAt)} />
                <InfoRow label="Менеджер" value={selectedThread.managerName} />
                <InfoRow label="Контакт" value={selectedThread.contactEmail || selectedThread.contactName || '-'} />
              </div>

              <div className="email-thread-messages">
                {selectedThread.messages.map((message) => (
                  <EmailMessageRow key={message.id} message={message} />
                ))}
              </div>
            </article>
          )}
        </div>
      )}
    </section>
  );
}

const EMAIL_THREAD_GROUPS: Array<{ key: EmailPipelineKey; label: string }> = [
  { key: 'sales', label: 'Продажи' },
  { key: 'base', label: 'База' },
  { key: 'assignedCompanies', label: 'Закреплённые компании' },
];

function normalizeEmailThreadGroups(data: PendingEmailThreadsResponse): PendingEmailThreadGroup[] {
  const serverGroups = new Map((data.groups ?? []).map((group) => [group.key, group]));
  return EMAIL_THREAD_GROUPS.map((group) => {
    const serverGroup = serverGroups.get(group.key);
    const threads = serverGroup?.threads ?? data.threads.filter((thread) => thread.pipelineKey === group.key);
    return {
      key: group.key,
      label: serverGroup?.label ?? group.label,
      summary: serverGroup?.summary ?? buildEmailThreadSummary(threads),
      threads,
    };
  });
}

function buildEmailThreadSummary(threads: PendingEmailThread[]) {
  return {
    total: threads.length,
    olderThan1h: threads.filter((thread) => thread.waitingSeconds >= 60 * 60).length,
    olderThan4h: threads.filter((thread) => thread.waitingSeconds >= 4 * 60 * 60).length,
    olderThan24h: threads.filter((thread) => thread.waitingSeconds >= 24 * 60 * 60).length,
  };
}

type EmailManagerFilterOption = {
  key: string;
  name: string;
  count: number;
};

function EmailManagerFilter({
  managers,
  onChange,
  selectedKeys,
  total,
  visibleTotal,
}: {
  managers: EmailManagerFilterOption[];
  onChange: (keys: string[]) => void;
  selectedKeys: string[];
  total: number;
  visibleTotal: number;
}) {
  function toggle(key: string, checked: boolean) {
    onChange(checked ? [...selectedKeys, key] : selectedKeys.filter((item) => item !== key));
  }

  return (
    <section className="email-manager-filter" aria-label="Фильтр писем по менеджерам">
      <div className="email-manager-filter-head">
        <div className="email-manager-filter-title">
          <Filter size={15} />
          <span>Менеджеры</span>
        </div>
        <div className="email-manager-filter-total">
          {selectedKeys.length ? `${visibleTotal} из ${total}` : `${total} всего`}
        </div>
      </div>
      <div className="email-manager-options">
        <button
          className={`email-manager-option ${selectedKeys.length === 0 ? 'active' : ''}`}
          type="button"
          onClick={() => onChange([])}
        >
          <span>Все менеджеры</span>
          <strong>{total}</strong>
        </button>
        {managers.map((manager) => (
          <label key={manager.key} className={`email-manager-option ${selectedKeys.includes(manager.key) ? 'active' : ''}`}>
            <input
              checked={selectedKeys.includes(manager.key)}
              type="checkbox"
              onChange={(event) => toggle(manager.key, event.target.checked)}
            />
            <span>{manager.name}</span>
            <strong>{manager.count}</strong>
          </label>
        ))}
      </div>
    </section>
  );
}

function buildEmailManagerFilters(threads: PendingEmailThread[]): EmailManagerFilterOption[] {
  const managers = new Map<string, EmailManagerFilterOption>();
  for (const thread of threads) {
    const key = emailManagerKey(thread);
    const existing = managers.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    managers.set(key, { key, name: thread.managerName || 'Без менеджера', count: 1 });
  }
  return [...managers.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

function emailManagerKey(thread: PendingEmailThread) {
  return thread.managerExternalId ? `crm:${thread.managerExternalId}` : `name:${thread.managerName || 'Без менеджера'}`;
}

function EmailMessageRow({ message }: { message: PendingEmailMessage }) {
  const incoming = message.direction === 'incoming';
  const text = message.body || message.summary;
  return (
    <div className={`email-message-row ${incoming ? 'incoming' : 'outgoing'}`}>
      <div className="email-message-head">
        <strong>{incoming ? 'Клиент' : 'Менеджер'}</strong>
        <span>{formatMoscowDateTime(message.createdAt)}</span>
      </div>
      {message.subject && <div className="email-message-subject">{message.subject}</div>}
      {text && <p>{text}</p>}
      <div className="email-message-meta">
        {message.from && <span>От: {message.from}</span>}
        {message.to && <span>Кому: {message.to}</span>}
        {message.attachCount > 0 && <span>Вложения: {message.attachCount}</span>}
      </div>
    </div>
  );
}

function emailWaitingSeconds(thread: PendingEmailThread, nowMs: number) {
  const startedAt = Date.parse(thread.lastIncomingAt);
  if (!Number.isFinite(startedAt)) return thread.waitingSeconds;
  return Math.max(0, Math.floor((nowMs - startedAt) / 1000));
}

function formatEmailWait(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function leadSlaRuntime(card: LeadSlaCard, nowMs: number) {
  const startMs = Date.parse(card.startAt);
  const dueMs = Date.parse(card.dueAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(dueMs)) {
    return {
      elapsedSeconds: card.elapsedSeconds,
      progressPercent: card.progressPercent,
      status: card.status,
      statusLabel: card.statusLabel,
      totalSeconds: Math.max(1, card.elapsedSeconds + card.remainingSeconds),
    };
  }

  const totalSeconds = Math.max(1, Math.round(moscowBusinessElapsedSeconds(startMs, dueMs)));
  const elapsedSeconds = Math.max(0, Math.round(moscowBusinessElapsedSeconds(startMs, nowMs)));
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  const progressPercent = Math.min(100, Math.max(0, Math.round((elapsedSeconds / totalSeconds) * 100)));
  const status = nowMs < startMs
    ? 'waiting'
    : elapsedSeconds >= totalSeconds
      ? 'overdue'
      : remainingSeconds <= 5 * 60
        ? 'warning'
        : 'active';

  return {
    elapsedSeconds,
    progressPercent,
    status,
    statusLabel: leadSlaStatusLabel(status),
    totalSeconds,
  };
}

const MOSCOW_WORKDAY_START_HOUR = 10;
const MOSCOW_WORKDAY_END_HOUR = 19;

function moscowBusinessElapsedSeconds(startMs: number, endMs: number) {
  if (endMs <= startMs) return 0;
  let cursor = startMs;
  let total = 0;

  while (cursor < endMs) {
    const workStart = nextMoscowBusinessStartMs(cursor);
    if (workStart >= endMs) break;

    const parts = moscowPartsFromMs(workStart);
    const workEnd = moscowDateMs(parts.year, parts.month, parts.day, MOSCOW_WORKDAY_END_HOUR);
    const chunkEnd = Math.min(workEnd, endMs);
    total += Math.max(0, chunkEnd - workStart);
    cursor = workEnd + 1;
  }

  return total / 1000;
}

function nextMoscowBusinessStartMs(value: number) {
  const parts = moscowPartsFromMs(value);
  const minutes = parts.hour * 60 + parts.minute;

  if (isMoscowBusinessDay(parts) && minutes < MOSCOW_WORKDAY_START_HOUR * 60) {
    return moscowDateMs(parts.year, parts.month, parts.day, MOSCOW_WORKDAY_START_HOUR);
  }
  if (isMoscowBusinessDay(parts) && minutes < MOSCOW_WORKDAY_END_HOUR * 60) {
    return value;
  }

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = moscowPartsFromMs(moscowDateMs(parts.year, parts.month, parts.day + offset, 12));
    if (isMoscowBusinessDay(candidate)) {
      return moscowDateMs(candidate.year, candidate.month, candidate.day, MOSCOW_WORKDAY_START_HOUR);
    }
  }
  return moscowDateMs(parts.year, parts.month, parts.day + 1, MOSCOW_WORKDAY_START_HOUR);
}

function moscowPartsFromMs(value: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const partValue = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = partValue('year');
  const month = partValue('month');
  const day = partValue('day');
  return {
    year,
    month,
    day,
    hour: partValue('hour'),
    minute: partValue('minute'),
    second: partValue('second'),
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function moscowDateMs(year: number, month: number, day: number, hour: number, minute = 0, second = 0, ms = 0) {
  return Date.UTC(year, month - 1, day, hour - 3, minute, second, ms);
}

function isMoscowBusinessDay(parts: { dayOfWeek: number }) {
  return parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5;
}

function leadSlaStatusLabel(status: string) {
  if (status === 'waiting') return 'Ждёт рабочего времени';
  if (status === 'overdue') return 'Просрочен';
  if (status === 'warning') return 'Скоро просрочится';
  return 'В работе';
}

function formatSlaClock(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  if (hours < 1) return mmss;
  return `${String(hours).padStart(2, '0')}:${mmss}`;
}

function PlatformTab({ user, onMessage }: { user: User; onMessage: (message: string) => void }) {
  const [telegramTemplates, setTelegramTemplates] = useState<TelegramTemplate[]>([]);
  const [telegramTemplateDrafts, setTelegramTemplateDrafts] = useState<Record<string, string>>({});
  const [telegramRecipientDrafts, setTelegramRecipientDrafts] = useState<Record<string, string[]>>({});
  const [telegramDeliveryModes, setTelegramDeliveryModes] = useState<Record<string, TelegramDeliveryMode>>({});
  const [expandedTelegramTemplates, setExpandedTelegramTemplates] = useState<Record<string, boolean>>({});
  const [telegramTemplateSaveState, setTelegramTemplateSaveState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const [userLinks, setUserLinks] = useState<UserLinksResponse | null>(null);
  const [userLinkDrafts, setUserLinkDrafts] = useState<Record<string, UserLinkDraft>>({});
  const [userLinkSaveState, setUserLinkSaveState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const [crmTelegramLinks, setCrmTelegramLinks] = useState<CrmTelegramLinksResponse | null>(null);
  const [crmTelegramActionState, setCrmTelegramActionState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const [loading, setLoading] = useState(true);
  const isOwner = user.businessRole === 'OWNER';

  const reload = useCallback(async () => {
    setLoading(true);
    const [nextTelegramTemplates, nextUserLinks, nextCrmTelegramLinks] = await Promise.all([
      isOwner ? api<TelegramTemplate[]>('/platform/telegram/templates') : Promise.resolve([]),
      isOwner ? api<UserLinksResponse>('/platform/admin/user-links') : Promise.resolve(null),
      api<CrmTelegramLinksResponse>('/platform/telegram/crm-users').catch(() => null),
    ]);
    setTelegramTemplates(nextTelegramTemplates);
    setTelegramTemplateDrafts(Object.fromEntries(nextTelegramTemplates.map((template) => [template.eventType, String(template.body ?? '')])));
    setTelegramRecipientDrafts(Object.fromEntries(nextTelegramTemplates.map((template) => [
      template.eventType,
      (template.recipients ?? []).map((recipient) => recipientValue(recipient)),
    ])));
    setTelegramDeliveryModes(Object.fromEntries(nextTelegramTemplates.map((template) => [
      template.eventType,
      template.deliveryMode ?? (template.recipientsMode === 'custom'
        ? ((template.recipients ?? []).length ? 'selected' : 'disabled')
        : 'system'),
    ])));
    setUserLinks(nextUserLinks);
    setCrmTelegramLinks(nextCrmTelegramLinks);
    if (nextUserLinks) {
      setUserLinkDrafts(Object.fromEntries(nextUserLinks.users.map((item) => [
        item.id,
        {
          businessRole: item.businessRole,
          crmUserId: item.crmUserId ?? '',
        },
      ])));
    }
    setLoading(false);
  }, [isOwner]);

  useEffect(() => {
    void reload().catch((error) => {
      setLoading(false);
      onMessage(error instanceof Error ? error.message : 'Не удалось загрузить Telegram');
    });
  }, [reload, onMessage]);

  async function saveTelegramTemplate(eventType: string) {
    setTelegramTemplateSaveState((current) => ({ ...current, [eventType]: 'saving' }));
    try {
      await api(`/platform/telegram/templates/${encodeURIComponent(eventType)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          body: telegramTemplateDrafts[eventType] ?? '',
          deliveryMode: telegramDeliveryModes[eventType] ?? 'system',
          recipients: (telegramRecipientDrafts[eventType] ?? []).map(parseRecipientValue).filter(Boolean),
        }),
      });
      await reload();
      setTelegramTemplateSaveState((current) => ({ ...current, [eventType]: 'saved' }));
      onMessage('Шаблон Telegram сохранён');
    } catch (error) {
      setTelegramTemplateSaveState((current) => ({ ...current, [eventType]: 'error' }));
      onMessage(error instanceof Error ? error.message : 'Шаблон Telegram не сохранён');
    }
  }

  async function saveUserLink(userId: string) {
    const draft = userLinkDrafts[userId];
    if (!draft) return;
    setUserLinkSaveState((current) => ({ ...current, [userId]: 'saving' }));
    try {
      await api(`/platform/admin/user-links/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          businessRole: draft.businessRole,
          crmUserId: draft.crmUserId || null,
        }),
      });
      await reload();
      setUserLinkSaveState((current) => ({ ...current, [userId]: 'saved' }));
      onMessage('Пользователь сохранён');
    } catch (error) {
      setUserLinkSaveState((current) => ({ ...current, [userId]: 'error' }));
      onMessage(error instanceof Error ? error.message : 'Пользователь не сохранён');
    }
  }

  async function createCrmTelegramCode(crmUserId: string) {
    setCrmTelegramActionState((current) => ({ ...current, [crmUserId]: 'saving' }));
    try {
      await api(`/platform/telegram/crm-users/${encodeURIComponent(crmUserId)}/link-code`, { method: 'POST' });
      await reload();
      setCrmTelegramActionState((current) => ({ ...current, [crmUserId]: 'saved' }));
      onMessage('Код Telegram для менеджера создан');
    } catch (error) {
      setCrmTelegramActionState((current) => ({ ...current, [crmUserId]: 'error' }));
      onMessage(error instanceof Error ? error.message : 'Код Telegram не создан');
    }
  }

  async function disconnectCrmTelegram(crmUserId: string) {
    setCrmTelegramActionState((current) => ({ ...current, [crmUserId]: 'saving' }));
    try {
      await api(`/platform/telegram/crm-users/${encodeURIComponent(crmUserId)}/link`, { method: 'DELETE' });
      await reload();
      setCrmTelegramActionState((current) => ({ ...current, [crmUserId]: 'saved' }));
      onMessage('Telegram менеджера отключён');
    } catch (error) {
      setCrmTelegramActionState((current) => ({ ...current, [crmUserId]: 'error' }));
      onMessage(error instanceof Error ? error.message : 'Telegram не отключён');
    }
  }

  return (
    <>
      <div className="page-row">
        <div>
          <h1 className="page-title">Telegram</h1>
          <p className="page-description">Пользователи, роли, Telegram и правила доставки уведомлений.</p>
        </div>
        <button className="btn" type="button" onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={15} />
          Обновить
        </button>
      </div>

      {isOwner && (
        <>
          <UserLinksPanel
            userLinks={userLinks}
            userLinkDrafts={userLinkDrafts}
            userLinkSaveState={userLinkSaveState}
            setUserLinkDrafts={setUserLinkDrafts}
            setUserLinkSaveState={setUserLinkSaveState}
            onSaveUserLink={saveUserLink}
          />
        </>
      )}

      <CrmTelegramLinksPanel
        crmTelegramLinks={crmTelegramLinks}
        actionState={crmTelegramActionState}
        onCreateCode={createCrmTelegramCode}
        onDisconnect={disconnectCrmTelegram}
      />

      {isOwner && (
        <section className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Telegram-уведомления</div>
              <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
                Режим доставки задаётся отдельно для каждого события.
              </div>
            </div>
          </div>
          <div className="card-body">
            {telegramTemplates.length === 0 && <div className="muted text-sm">Шаблоны уведомлений пока не загружены.</div>}
            <div className="telegram-template-grid">
              {telegramTemplates.map((template) => {
                const mode = telegramDeliveryModes[template.eventType] ?? template.deliveryMode ?? 'system';
                const allowedModes = template.allowedDeliveryModes?.length ? template.allowedDeliveryModes : telegramDeliveryModeOrder;
                const saveState = telegramTemplateSaveState[template.eventType];
                const selectedCount = telegramRecipientDrafts[template.eventType]?.length ?? 0;
                const expanded = expandedTelegramTemplates[template.eventType] ?? false;
                const saveDisabled = saveState === 'saving' || (mode === 'selected' && selectedCount === 0);
                return (
                  <article className="telegram-template-card" key={template.eventType}>
                    <div className="telegram-template-card-header">
                      <div className="telegram-template-title">{template.name}</div>
                      {saveState === 'saved' && <span className="badge badge-green">Сохранено</span>}
                      {saveState === 'error' && <span className="badge badge-red">Ошибка</span>}
                    </div>
                    <label className="label" htmlFor={`telegram-mode-${template.eventType}`}>Отправка</label>
                    <select
                      className="select"
                      id={`telegram-mode-${template.eventType}`}
                      value={mode}
                      onChange={(event) => {
                        const nextMode = event.target.value as TelegramDeliveryMode;
                        setTelegramDeliveryModes((current) => ({
                          ...current,
                          [template.eventType]: nextMode,
                        }));
                        setTelegramTemplateSaveState((current) => {
                          const next = { ...current };
                          delete next[template.eventType];
                          return next;
                        });
                      }}
                    >
                      {allowedModes.map((deliveryMode) => (
                        <option key={deliveryMode} value={deliveryMode}>
                          {telegramDeliveryModeLabels[deliveryMode]}
                        </option>
                      ))}
                    </select>
                    <div className="telegram-template-hint">
                      {mode === 'selected' && selectedCount > 0
                        ? `Выбрано: ${selectedCount}`
                        : telegramDeliveryModeHints[mode]}
                    </div>
                    {mode === 'selected' && (
                      <TelegramRecipientsSelect
                        value={telegramRecipientDrafts[template.eventType] ?? []}
                        userLinks={userLinks}
                        crmTelegramLinks={crmTelegramLinks}
                        onChange={(nextValue) => {
                          setTelegramRecipientDrafts((current) => ({
                            ...current,
                            [template.eventType]: nextValue,
                          }));
                          setTelegramTemplateSaveState((current) => {
                            const next = { ...current };
                            delete next[template.eventType];
                            return next;
                          });
                        }}
                      />
                    )}
                    <div className="telegram-template-actions">
                      <button
                        className="btn"
                        type="button"
                        onClick={() => setExpandedTelegramTemplates((current) => ({
                          ...current,
                          [template.eventType]: !expanded,
                        }))}
                      >
                        <Settings size={15} />
                        {expanded ? 'Скрыть текст' : 'Текст'}
                      </button>
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={saveDisabled}
                        onClick={() => saveTelegramTemplate(template.eventType)}
                      >
                        <Save size={15} />
                        {saveState === 'saving' ? 'Сохраняю...' : 'Сохранить'}
                      </button>
                    </div>
                    {expanded && (
                      <div className="telegram-template-editor">
                        <textarea
                          className="field min-h-[120px]"
                          value={telegramTemplateDrafts[template.eventType] ?? ''}
                          onChange={(event) => {
                            setTelegramTemplateDrafts((current) => ({
                              ...current,
                              [template.eventType]: event.target.value,
                            }));
                            setTelegramTemplateSaveState((current) => {
                              const next = { ...current };
                              delete next[template.eventType];
                              return next;
                            });
                          }}
                        />
                        <div className="text-xs text-[var(--pb-text-secondary)]">
                          Вставки: {'{managerMention}'}, {'{dealUrl}'}, {'{deal}'}, {'{manager}'}, {'{amount}'}, {'{stage}'}, {'{pipeline}'}, {'{group}'}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function TelegramRecipientsSelect({
  value,
  userLinks,
  crmTelegramLinks,
  onChange,
}: {
  value: string[];
  userLinks: UserLinksResponse | null;
  crmTelegramLinks: CrmTelegramLinksResponse | null;
  onChange: (value: string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const options = telegramRecipientOptions(userLinks, crmTelegramLinks);
  const selected = new Set(value);
  const selectedOptions = options.filter((option) => selected.has(option.value));
  const filteredOptions = options.filter((option) =>
    option.label.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const buttonText = selectedOptions.length === 0
    ? 'Получатели не выбраны'
    : selectedOptions.length === 1
      ? selectedOptions[0].label
      : `${selectedOptions.length} получателя`;
  const hint = selectedOptions.length === 0
    ? 'Выберите минимум одного получателя.'
    : 'Уведомление уйдёт только выбранным.';

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function toggleRecipient(optionValue: string) {
    const currentSelected = new Set(value);
    onChange(currentSelected.has(optionValue) ? value.filter((item) => item !== optionValue) : [...value, optionValue]);
  }

  return (
    <div className="telegram-recipient-dropdown" ref={rootRef}>
      <label className="label">Кому</label>
      <button
        className={`telegram-recipient-trigger ${selectedOptions.length === 0 ? 'empty' : ''}`}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{buttonText}</span>
        <ChevronDown size={15} />
      </button>
      <div className="telegram-recipient-hint">{hint}</div>
      {open && (
        <div className="telegram-recipient-panel">
          <div className="telegram-recipient-actions">
            <button
              className={selectedOptions.length === 0 ? 'active danger' : ''}
              type="button"
              onClick={() => {
                onChange([]);
              }}
            >
              Очистить
            </button>
          </div>
          <input
            className="telegram-recipient-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Найти получателя"
          />
          <div className="telegram-recipient-list">
            {filteredOptions.length === 0 && <div className="telegram-recipient-empty">Подключённых получателей нет</div>}
            {filteredOptions.map((option) => (
              <label className="telegram-recipient-row" key={option.value}>
                <input
                  checked={selected.has(option.value)}
                  type="checkbox"
                  onChange={() => toggleRecipient(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserLinksPanel({
  userLinks,
  userLinkDrafts,
  userLinkSaveState,
  setUserLinkDrafts,
  setUserLinkSaveState,
  onSaveUserLink,
}: {
  userLinks: UserLinksResponse | null;
  userLinkDrafts: Record<string, UserLinkDraft>;
  userLinkSaveState: Record<string, 'saving' | 'saved' | 'error'>;
  setUserLinkDrafts: Dispatch<SetStateAction<Record<string, UserLinkDraft>>>;
  setUserLinkSaveState: Dispatch<SetStateAction<Record<string, 'saving' | 'saved' | 'error'>>>;
  onSaveUserLink: (userId: string) => Promise<void>;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Пользователи и роли</div>
          <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
            Здесь задаётся связка: аккаунт платформы, человек в amoCRM, роль в сервисе и Telegram.
          </div>
        </div>
      </div>
      <div className="card-body">
        {!userLinks ? (
          <div className="muted text-sm">Загрузка пользователей...</div>
        ) : userLinks.users.length === 0 ? (
          <div className="empty-state">Пользователей платформы пока нет.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table admin-user-links-table">
              <thead>
                <tr>
                  <th>Аккаунт платформы</th>
                  <th>Роль</th>
                  <th>Аккаунт amoCRM</th>
                  <th>Telegram</th>
                  <th>Сохранение</th>
                </tr>
              </thead>
              <tbody>
                {userLinks.users.map((item) => {
                  const draft = userLinkDrafts[item.id] ?? {
                    businessRole: item.businessRole,
                    crmUserId: item.crmUserId ?? '',
                  };
                  const telegramLabel = telegramAccountLabel(item.telegramAccount);
                  const saveState = userLinkSaveState[item.id];
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="font-bold text-[var(--pb-text-primary)]">{item.name}</div>
                        <div className="text-xs text-[var(--pb-text-secondary)]">{item.email}</div>
                        <div className="mt-1 text-xs text-[var(--pb-text-muted)]">
                          Доступ: {platformAccessLabel(item.role)}
                        </div>
                      </td>
                      <td>
                        <select
                          className="select admin-link-select"
                          value={draft.businessRole}
                          onChange={(event) => {
                            const businessRole = event.target.value as PlatformBusinessRole;
                            setUserLinkDrafts((current) => ({
                              ...current,
                              [item.id]: { ...draft, businessRole },
                            }));
                            setUserLinkSaveState((current) => {
                              const next = { ...current };
                              delete next[item.id];
                              return next;
                            });
                          }}
                        >
                          <option value="OWNER">Владелец</option>
                          <option value="ROP">РОП</option>
                          <option value="MANAGER">Менеджер</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="select admin-link-select"
                          value={draft.crmUserId}
                          onChange={(event) => {
                            setUserLinkDrafts((current) => ({
                              ...current,
                              [item.id]: { ...draft, crmUserId: event.target.value },
                            }));
                            setUserLinkSaveState((current) => {
                              const next = { ...current };
                              delete next[item.id];
                              return next;
                            });
                          }}
                        >
                          <option value="">Не выбран</option>
                          {item.crmUser && !userLinks.crmUsers.some((crmUser) => crmUser.id === item.crmUser?.id) && (
                            <option value={item.crmUser.id}>{crmUserOptionLabel(item.crmUser)}</option>
                          )}
                          {userLinks.crmUsers.map((crmUser) => (
                            <option key={crmUser.id} value={crmUser.id}>
                              {crmUserOptionLabel(crmUser)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={`badge ${item.telegramAccount?.isActive ? 'badge-green' : 'badge-yellow'}`}>
                          {telegramLabel}
                        </span>
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className="btn"
                            type="button"
                            disabled={saveState === 'saving'}
                            onClick={() => onSaveUserLink(item.id)}
                          >
                            <Save size={15} />
                            {saveState === 'saving' ? 'Сохраняю...' : 'Сохранить'}
                          </button>
                          {saveState === 'saved' && <span className="badge badge-green">Сохранено</span>}
                          {saveState === 'error' && <span className="badge badge-red">Ошибка</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function CrmTelegramLinksPanel({
  crmTelegramLinks,
  actionState,
  onCreateCode,
  onDisconnect,
}: {
  crmTelegramLinks: CrmTelegramLinksResponse | null;
  actionState: Record<string, 'saving' | 'saved' | 'error'>;
  onCreateCode: (crmUserId: string) => Promise<void>;
  onDisconnect: (crmUserId: string) => Promise<void>;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Telegram менеджеров</div>
          <div className="mt-1 text-sm text-[var(--pb-text-secondary)]">
            Менеджер отправляет код боту в личку. Доступ в платформу ему не нужен.
          </div>
        </div>
      </div>
      <div className="card-body">
        {!crmTelegramLinks ? (
          <div className="muted text-sm">Нет доступа к списку менеджеров или не задана связка с amoCRM.</div>
        ) : crmTelegramLinks.crmUsers.length === 0 ? (
          <div className="empty-state">Нет активных менеджеров amoCRM.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table crm-telegram-links-table">
              <thead>
                <tr>
                  <th>Менеджер amoCRM</th>
                  <th>Группа</th>
                  <th>Telegram</th>
                  <th>Код</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {crmTelegramLinks.crmUsers.map((item) => {
                  const state = actionState[item.id];
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="font-bold text-[var(--pb-text-primary)]">{item.name}</div>
                        {item.email && <div className="text-xs text-[var(--pb-text-secondary)]">{item.email}</div>}
                      </td>
                      <td>{item.group?.name ?? '-'}</td>
                      <td>
                        <span className={`badge ${item.telegramAccount?.isActive ? 'badge-green' : 'badge-yellow'}`}>
                          {telegramAccountLabel(item.telegramAccount)}
                        </span>
                      </td>
                      <td>
                        {item.activeCode?.code ? (
                          <div>
                            <div className="mono-num font-bold">{item.activeCode.code}</div>
                            <div className="text-xs text-[var(--pb-text-secondary)]">/start {item.activeCode.code}</div>
                          </div>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className="btn"
                            type="button"
                            disabled={state === 'saving'}
                            onClick={() => onCreateCode(item.id)}
                          >
                            <Plus size={15} />
                            {state === 'saving' ? 'Создаю...' : 'Выдать код'}
                          </button>
                          {item.telegramAccount?.isActive && (
                            <button
                              className="btn"
                              type="button"
                              disabled={state === 'saving'}
                              onClick={() => onDisconnect(item.id)}
                            >
                              <Trash2 size={15} />
                              Отключить
                            </button>
                          )}
                          {state === 'saved' && <span className="badge badge-green">Готово</span>}
                          {state === 'error' && <span className="badge badge-red">Ошибка</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function telegramRecipientOptions(userLinks: UserLinksResponse | null, crmTelegramLinks: CrmTelegramLinksResponse | null) {
  const platformOptions = (userLinks?.users ?? [])
    .filter((item) => item.telegramAccount?.isActive)
    .map((item) => ({
      value: recipientValue({ kind: 'platform_user', id: item.id }),
      label: `${item.name} · платформа · ${telegramAccountLabel(item.telegramAccount)}`,
    }));
  const crmOptions = (crmTelegramLinks?.crmUsers ?? [])
    .filter((item) => item.telegramAccount?.isActive)
    .map((item) => ({
      value: recipientValue({ kind: 'crm_user', id: item.id }),
      label: `${item.name} · ${item.group?.name ?? 'amoCRM'} · ${telegramAccountLabel(item.telegramAccount)}`,
    }));
  return [...platformOptions, ...crmOptions];
}

function recipientValue(recipient: TelegramTemplateRecipient) {
  return `${recipient.kind}:${recipient.id}`;
}

function parseRecipientValue(value: string): TelegramTemplateRecipient | null {
  const [kind, id] = value.split(':');
  if ((kind !== 'platform_user' && kind !== 'crm_user') || !id) return null;
  return { kind, id };
}
const planMetricOptions = [
  { value: 'closed_amount', label: 'Выручка закрытых сделок', unit: 'rub' },
  { value: 'closed_deal_count', label: 'Закрытые сделки', unit: 'number' },
  { value: 'deal_amount', label: 'Сумма созданных сделок', unit: 'rub' },
  { value: 'deal_count', label: 'Созданные сделки', unit: 'number' },
  { value: 'task_count', label: 'Задачи', unit: 'number' },
];

function getAlertMetricOptions(template?: ReportTemplate) {
  const contractMetrics = template?.config?.contract?.metrics ?? [];
  const metrics = contractMetrics.map((metric) => ({ value: metric.id, label: metric.label }));
  return [
    { value: 'summary.count', label: 'Количество' },
    { value: 'summary.totalAmount', label: 'Сумма' },
    { value: 'summary.avgAmount', label: 'Средний чек' },
    ...metrics,
  ];
}

function getPlanTargetName(targetType: string, targetId: string, options: Options | null) {
  if (targetType === 'MANAGER') return options?.managers.find((manager) => manager.id === targetId)?.name ?? null;
  if (targetType === 'GROUP') return options?.groups.find((group) => group.id === targetId)?.name ?? null;
  return 'Компания';
}

function severityLabel(severity: QualityRule['severity']) {
  if (severity === 'CRITICAL') return 'критично';
  if (severity === 'WARNING') return 'важно';
  return 'инфо';
}

function severityClass(severity: QualityRule['severity']) {
  if (severity === 'CRITICAL') return 'badge-red';
  if (severity === 'WARNING') return 'badge-yellow';
  return 'badge-blue';
}

function platformAccessLabel(role: UserRole) {
  return role === 'ADMIN' ? 'админ' : 'пользователь';
}

function businessRoleLabel(role?: PlatformBusinessRole) {
  if (role === 'OWNER') return 'Владелец';
  if (role === 'ROP') return 'РОП';
  return 'Менеджер';
}

function crmUserOptionLabel(user: LinkedCrmUser) {
  return [
    user.name,
    user.group?.name ? `группа: ${user.group.name}` : null,
    user.email,
  ].filter(Boolean).join(' · ');
}

function telegramAccountLabel(account?: TelegramAccountSummary | null) {
  if (!account?.isActive) return 'не подключен';
  if (account.username) return `@${account.username.replace(/^@/, '')}`;
  const name = [account.firstName, account.lastName].filter(Boolean).join(' ').trim();
  return name || 'подключен';
}

function MiniStat({ label, value, tone }: { label: string; value: string | number; tone: 'green' | 'yellow' | 'red' | 'blue' }) {
  const toneLabel = tone === 'green' ? 'ок' : tone === 'red' ? 'внимание' : tone === 'yellow' ? 'настройка' : 'активно';
  return (
    <div className="card p-4">
      <div className="text-xs font-bold uppercase text-[var(--pb-text-secondary)]">{label}</div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="text-2xl font-bold">{value}</div>
        <span className={`badge badge-${tone}`}>{toneLabel}</span>
      </div>
    </div>
  );
}

function CompactTable({ columns, rows, empty }: { columns: string[]; rows: Array<Array<ReactNode>>; empty: string }) {
  if (!rows.length) return <div className="empty-state">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="table min-w-full">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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

  const hasConnection = Boolean(connection?.subdomain);
  const syncDisabled = !hasConnection || connection?.status === 'SYNCING';
  const connectionStatusText =
    connection?.status === 'ACTIVE'
      ? 'подключено'
      : connection?.status === 'SYNCING'
        ? 'синхронизация'
        : connection?.status === 'ERROR'
          ? 'ошибка синхронизации'
          : 'не подключено';

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
            <span className={`badge ${connection?.status === 'ACTIVE' || connection?.status === 'SYNCING' ? 'badge-green' : 'badge-yellow'}`}>
              {connectionStatusText}
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
              <button className="btn" type="button" onClick={() => sync('FULL')} disabled={syncDisabled}>
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
            <button className="btn" type="button" onClick={() => sync('INCREMENTAL')} disabled={syncDisabled}>
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

function ReportResultDetails({
  amoDomain = '',
  result,
  template,
}: {
  amoDomain?: string;
  result: Record<string, any> | null;
  template: ReportTemplate;
}) {
  if (!result) return <div className="muted text-sm">Нет данных для отображения.</div>;

  if (result.type === 'dealCycle' || result.type === 'dealStageAge') {
    return <DealCycleReport amoDomain={amoDomain} result={result} />;
  }

  if (result.type === 'contract') {
    const rows = (result.rows ?? []) as Array<Record<string, any>>;
    const metrics = (result.metrics ?? []) as ContractMetricPayload[];
    const conversions = (result.conversions ?? []) as ContractConversionDraft[];
    const durations = (result.durations ?? []) as ContractDurationDraft[];
    const summaryRows = (result.summaryRows ?? []) as Array<Record<string, any>>;
    const summary = summaryRows[0];
    const columns = [
      ...rows.map((row) => ({ id: String(row.groupId), label: String(row.groupName), row, summary: null as Record<string, any> | null })),
      ...(summary ? [{ id: String(summary.id), label: String(summary.label), row: null as Record<string, any> | null, summary }] : []),
    ];

    if (columns.length === 0 || (metrics.length === 0 && conversions.length === 0 && durations.length === 0)) {
      return <div className="muted text-sm">Нет данных для отображения.</div>;
    }

    return (
      <div className="report-matrix-wrap">
        <table className="report-matrix">
          <thead>
            <tr>
              <th>Показатель</th>
              {columns.map((column) => (
                <th key={column.id} className={column.summary ? 'summary-col' : undefined} title={column.label}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.id}>
                <th title={metric.label}>{metric.label}</th>
                {columns.map((column) => {
                  const source = column.summary ? column.summary.metrics : column.row?.metrics;
                  const value = ((source as Record<string, ContractMetricValue>)?.[metric.id] ?? {}) as ContractMetricValue;
                  return (
                    <td
                      key={`${column.id}-${metric.id}`}
                      className={`${column.summary ? 'summary-col mono-num' : 'mono-num'}${hasContractDealDrilldown(value) ? ' drilldown-popover-cell' : ''}`}
                    >
                      <ContractMetricCell amoDomain={amoDomain} metric={metric} value={value} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {conversions.map((conversion) => (
              <tr key={conversion.id}>
                <th title={conversion.label}>{conversion.label}</th>
                {columns.map((column) => {
                  if (column.summary) return <td key={`${column.id}-${conversion.id}`} className="summary-col muted">-</td>;
                  const value = ((column.row?.conversions as Record<string, ContractConversionValue>)?.[conversion.id] ?? {}) as ContractConversionValue;
                  return (
                    <td
                      key={`${column.id}-${conversion.id}`}
                      className={`mono-num${hasContractDealDrilldown(value) ? ' drilldown-popover-cell' : ''}`}
                    >
                      <ContractConversionCell amoDomain={amoDomain} value={value} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {durations.map((duration) => (
              <tr key={duration.id}>
                <th title={duration.label}>{duration.label}</th>
                {columns.map((column) => {
                  if (column.summary) return <td key={`${column.id}-${duration.id}`} className="summary-col muted">-</td>;
                  const value = ((column.row?.durations as Record<string, ContractDurationValue>)?.[duration.id] ?? {}) as ContractDurationValue;
                  return (
                    <td key={`${column.id}-${duration.id}`} className="duration-popover-cell mono-num">
                      <ContractDurationCell amoDomain={amoDomain} value={value} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.some((row) => row.rowTotal) && (
              <tr>
                <th>Итог по менеджеру</th>
                {columns.map((column) => (
                  <td key={`${column.id}-row-total`} className={column.summary ? 'summary-col mono-num' : 'mono-num'}>
                    {column.row?.rowTotal ? formatNumber(column.row.rowTotal.value) : '-'}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (result.type === 'lossReasons') {
    return <LossReasonsReport result={result} />;
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

  if (result.type === 'revenueProfitForecast') {
    return <RevenueProfitForecastReport amoDomain={amoDomain} result={result} />;
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

  return <div className="muted text-sm">Всего сделок: {(result.summary?.count ?? 0) as number}</div>;
}

type ContractDealSample = {
  dealId: string;
  dealExternalId?: string;
  dealTitle: string;
  amount?: number | null;
  expectedAmount?: number | null;
  probabilityPercent?: number | null;
  stageName?: string | null;
  pipelineName?: string | null;
};

type ContractDurationSample = ContractDealSample & {
  durationDays: number;
};

type ContractMetricValue = {
  value?: number | null;
  unit?: string;
  dealCount?: number;
  sampleSize?: number;
  samples?: ContractDealSample[];
  from?: number;
  to?: number;
  fromSamples?: ContractDealSample[];
  toSamples?: ContractDealSample[];
};

type ContractConversionValue = {
  conversion?: number | null;
  from?: number;
  to?: number;
  sampleSize?: number;
  samples?: ContractDealSample[];
  fromSamples?: ContractDealSample[];
  toSamples?: ContractDealSample[];
};

type ContractDurationValue = {
  avgDays?: number | null;
  sampleSize?: number;
  samples?: ContractDurationSample[];
};

function ContractMetricCell({
  amoDomain,
  metric,
  value,
}: {
  amoDomain: string;
  metric: ContractMetricPayload;
  value: ContractMetricValue;
}) {
  const label = formatMetricValue(value.value, value.unit ?? metric.display);
  if (!hasContractDealDrilldown(value)) return <>{label}</>;

  if (metric.type === 'conversion') {
    return (
      <ContractDealDrilldown
        amoDomain={amoDomain}
        trigger={label}
        title="Сделки в конверсии"
        meta={`База: ${formatNumber(value.from ?? 0)} · дошли: ${formatNumber(value.to ?? 0)}`}
        sections={[
          { label: 'База конверсии', count: value.from ?? value.fromSamples?.length ?? 0, samples: value.fromSamples ?? [] },
          { label: 'Дошли до шага', count: value.to ?? value.toSamples?.length ?? 0, samples: value.toSamples ?? [] },
        ]}
      />
    );
  }

  return (
    <ContractDealDrilldown
      amoDomain={amoDomain}
      trigger={label}
      title="Сделки в расчёте"
      meta={`В расчёте: ${formatNumber(value.sampleSize ?? value.dealCount ?? value.samples?.length ?? 0)} сделок`}
      sections={[{ samples: value.samples ?? [] }]}
    />
  );
}

function ContractConversionCell({ amoDomain, value }: { amoDomain: string; value: ContractConversionValue }) {
  const label = value.conversion == null ? 'нет данных' : `${formatNumber(value.conversion)}%`;
  if (!hasContractDealDrilldown(value)) return <>{label}</>;

  return (
    <ContractDealDrilldown
      amoDomain={amoDomain}
      trigger={label}
      title="Сделки в конверсии"
      meta={`База: ${formatNumber(value.from ?? 0)} · дошли: ${formatNumber(value.to ?? 0)}`}
      sections={[
        { label: 'База конверсии', count: value.from ?? value.fromSamples?.length ?? 0, samples: value.fromSamples ?? [] },
        { label: 'Дошли до шага', count: value.to ?? value.toSamples?.length ?? 0, samples: value.toSamples ?? [] },
      ]}
    />
  );
}

function ContractDealDrilldown({
  amoDomain,
  trigger,
  title,
  meta,
  sections,
}: {
  amoDomain: string;
  trigger: string;
  title: string;
  meta: string;
  sections: Array<{ label?: string; count?: number; samples: ContractDealSample[] }>;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [popoverOffset, setPopoverOffset] = useState(0);
  const placePopover = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') return;
    const width = Math.min(380, window.innerWidth - 56);
    const viewportLeft = Math.min(Math.max(rect.left, 16), window.innerWidth - width - 16);
    setPopoverOffset(Math.round(viewportLeft - rect.left));
  }, []);

  return (
    <span
      ref={triggerRef}
      className="drilldown-popover-trigger"
      style={{ '--drilldown-popover-left': `${popoverOffset}px` } as CSSProperties}
      tabIndex={0}
      onFocus={placePopover}
      onMouseEnter={placePopover}
    >
      {trigger}
      <span className="duration-popover">
        <span className="deal-cycle-tooltip-title">{title}</span>
        <span className="deal-cycle-tooltip-meta">{meta}</span>
        <span className="deal-cycle-tooltip-list">
          {sections.map((section, sectionIndex) => (
            <span key={`${section.label ?? 'deals'}-${sectionIndex}`} className="deal-cycle-tooltip-section">
              {section.label && (
                <span className="deal-cycle-tooltip-section-title">
                  {section.label}: {formatNumber(section.count ?? section.samples.length)}
                </span>
              )}
              {section.samples.length === 0 ? (
                <span className="deal-cycle-tooltip-empty">Нет сделок</span>
              ) : (
                section.samples.map((sample, index) => {
                  const dealUrl = buildAmoDealUrl(amoDomain, sample.dealExternalId);
                  return (
                    <span key={`${sample.dealId}-${index}`} className="deal-cycle-tooltip-row">
                      {dealUrl ? (
                        <a className="deal-cycle-tooltip-link" href={dealUrl} target="_blank" rel="noreferrer" title={sample.dealTitle}>
                          {sample.dealTitle}
                        </a>
                      ) : (
                        <span title={sample.dealTitle}>{sample.dealTitle}</span>
                      )}
                      <strong>{formatContractDealSampleMeta(sample)}</strong>
                    </span>
                  );
                })
              )}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function hasContractDealDrilldown(value: ContractMetricValue | ContractConversionValue) {
  return Boolean(
    value.samples?.length ||
      value.fromSamples?.length ||
      value.toSamples?.length,
  );
}

function formatContractDealSampleMeta(sample: ContractDealSample) {
  if (Number.isFinite(Number(sample.expectedAmount))) {
    const probability = Number.isFinite(Number(sample.probabilityPercent)) ? ` · ${sample.probabilityPercent}%` : '';
    return `${formatMoney(Number(sample.expectedAmount))}${probability}`;
  }
  if (Number.isFinite(Number(sample.amount))) return formatMoney(Number(sample.amount));
  return sample.stageName ?? '';
}

function ContractDurationCell({ amoDomain, value }: { amoDomain: string; value: ContractDurationValue }) {
  const samples = value.samples ?? [];
  const label = formatDurationFromDays(value.avgDays);
  if (!samples.length) return <>{label}</>;

  return (
    <span className="duration-popover-trigger" tabIndex={0}>
      {label}
      <span className="duration-popover">
        <span className="deal-cycle-tooltip-title">Сделки в расчёте</span>
        <span className="deal-cycle-tooltip-meta">В расчёте: {formatNumber(value.sampleSize ?? samples.length)} сделок</span>
        <span className="deal-cycle-tooltip-list">
          {samples.map((sample, index) => {
            const dealUrl = buildAmoDealUrl(amoDomain, sample.dealExternalId);
            return (
              <span key={`${sample.dealId}-${index}`} className="deal-cycle-tooltip-row">
                {dealUrl ? (
                  <a className="deal-cycle-tooltip-link" href={dealUrl} target="_blank" rel="noreferrer" title={sample.dealTitle}>
                    {sample.dealTitle}
                  </a>
                ) : (
                  <span title={sample.dealTitle}>{sample.dealTitle}</span>
                )}
                <strong>{formatDurationFromDays(sample.durationDays)}</strong>
              </span>
            );
          })}
        </span>
      </span>
    </span>
  );
}

type LossReasonManager = {
  id: string;
  name: string;
};

type LossReasonRow = {
  reasonId: string;
  reasonName: string;
  values: Record<string, number>;
  percentages?: Record<string, number>;
  total: number;
  totalPercent?: number;
};

function LossReasonsReport({ result }: { result: Record<string, any> }) {
  const managers = (result.managers ?? []) as LossReasonManager[];
  const rows = (result.rows ?? []) as LossReasonRow[];
  const summary = (result.summary ?? {}) as { total?: number; values?: Record<string, number> };

  if (!rows.length) {
    return <div className="muted text-sm">За выбранный период отказов не найдено.</div>;
  }

  const percent = (count: number, denominator: number) =>
    denominator > 0 ? Number(((count / denominator) * 100).toFixed(2)) : 0;
  const cellValue = (count: number, percentValue: number) => `${formatNumber(count)} (${formatPercent(percentValue)})`;

  return (
    <div className="report-matrix-wrap">
      <table className="report-matrix">
        <thead>
          <tr>
            <th>Причина отказа</th>
            {managers.map((manager) => (
              <th key={manager.id} title={manager.name}>
                {manager.name}
              </th>
            ))}
            <th className="summary-col">Всего</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reasonId}>
              <th title={row.reasonName}>{row.reasonName}</th>
              {managers.map((manager) => {
                const value = row.values?.[manager.id] ?? 0;
                const managerTotal = summary.values?.[manager.id] ?? 0;
                return (
                  <td key={`${row.reasonId}-${manager.id}`} className="mono-num">
                    {cellValue(value, row.percentages?.[manager.id] ?? percent(value, managerTotal))}
                  </td>
                );
              })}
              <td className="summary-col mono-num">{cellValue(row.total, row.totalPercent ?? percent(row.total, summary.total ?? 0))}</td>
            </tr>
          ))}
          <tr>
            <th>Всего</th>
            {managers.map((manager) => (
              <td key={`summary-${manager.id}`} className="mono-num">
                {formatNumber(summary.values?.[manager.id] ?? 0)}
              </td>
            ))}
            <td className="summary-col mono-num">{formatNumber(summary.total ?? 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

type DealCycleStage = {
  stageId: string;
  stageName: string;
  color?: string | null;
  avgDays: number | null;
  sampleSize: number;
  samples?: Array<{ dealId: string; dealExternalId?: string; dealTitle: string; durationDays: number }>;
};

type DealCycleRow = {
  managerId: string;
  managerName: string;
  totalDeals: number;
  stages: DealCycleStage[];
  stageAverage?: { avgDays: number | null; sampleSize: number };
  stageTotal?: { avgDays: number | null; sampleSize: number };
  overallAverage?: { avgDays: number | null; sampleSize: number };
  successCycle?: { avgDays: number | null; sampleSize: number };
  lostCycle?: { avgDays: number | null; sampleSize: number };
};

type RevenueForecastDeal = {
  dealId: string;
  dealExternalId?: string;
  title: string;
  manager: string;
  stage: string;
  source: string;
  probabilityPercent: number;
  amount: number;
  revenue: number;
  profit: number | null;
  predictedShipAt: string | null;
};

type RevenueForecastRow = {
  id: string;
  label: string;
  count: number;
  revenue: number;
  profit: number | null;
  deals: RevenueForecastDeal[];
};

function RevenueProfitForecastReport({ amoDomain, result }: { amoDomain: string; result: Record<string, any> }) {
  const rows = (result.rows ?? []) as RevenueForecastRow[];
  const summary = result.summary ?? {};
  const shippingCycle = result.shippingCycle ?? {};
  const profitAvailable = Boolean(result.profit?.available);
  const profitBasis = String(result.profit?.basis ?? '32% от суммы сделки');
  const warnings = (result.warnings ?? []) as string[];
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  if (result.ready === false) {
    return (
      <div className="grid gap-3">
        {(warnings.length ? warnings : ['Не удалось найти нужные воронки или этапы для расчёта.']).map((warning) => (
          <div key={warning} className="badge badge-red justify-start">
            <AlertCircle size={14} />
            {warning}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="revenue-forecast-report">
      <div className="revenue-forecast-summary">
        <div className="revenue-forecast-card">
          <span>До конца месяца</span>
          <strong className="mono-num">{formatMoney(summary.revenue)}</strong>
          <small>{formatNumber(summary.count ?? 0)} сделок</small>
        </div>
        <div className="revenue-forecast-card">
          <span>Прибыль</span>
          <strong className="mono-num">{profitAvailable ? formatMoney(summary.profit) : 'не настроено'}</strong>
          <small>{profitAvailable ? profitBasis : 'не настроено'}</small>
        </div>
        <div className="revenue-forecast-card">
          <span>Цикл отгрузки</span>
          <strong className="mono-num">{formatDurationFromDays(shippingCycle.avgDays)}</strong>
          <small>{formatNumber(shippingCycle.sampleSize ?? 0)} сделок за последние 30 дней</small>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="revenue-forecast-notes">
          {warnings.map((warning) => (
            <span key={warning}>
              <AlertCircle size={14} />
              {warning}
            </span>
          ))}
        </div>
      )}

      <div className="revenue-forecast-table-wrap">
        <table className="revenue-forecast-table">
          <thead>
            <tr>
              <th>Сценарий</th>
              <th>Сделок</th>
              <th>Выручка</th>
              <th>Прибыль</th>
              <th>Сделки в расчёте</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isExpanded = Boolean(expandedRows[row.id]);
              const visibleDeals = isExpanded ? row.deals : row.deals.slice(0, 8);
              const hiddenDealsCount = row.deals.length - visibleDeals.length;
              return (
                <tr key={row.id}>
                  <th>{row.label}</th>
                  <td className="mono-num">{formatNumber(row.count)}</td>
                  <td className="mono-num">{formatMoney(row.revenue)}</td>
                  <td className="mono-num">{profitAvailable ? formatMoney(row.profit) : 'не настроено'}</td>
                  <td>
                    {row.deals.length === 0 ? (
                      <span className="muted">нет сделок</span>
                    ) : (
                      <div className="revenue-forecast-deals">
                        {visibleDeals.map((deal) => {
                          const dealUrl = buildAmoDealUrl(amoDomain, deal.dealExternalId);
                          return (
                            <div key={deal.dealId} className="revenue-forecast-deal">
                              <div className="min-w-0">
                                {dealUrl ? (
                                  <a href={dealUrl} target="_blank" rel="noreferrer" title={deal.title}>
                                    {deal.title}
                                  </a>
                                ) : (
                                  <span title={deal.title}>{deal.title}</span>
                                )}
                                <small>
                                  {deal.manager} · {deal.stage} · {deal.probabilityPercent}%
                                </small>
                              </div>
                              <div className="mono-num text-right">
                                <strong>{formatMoney(deal.revenue)}</strong>
                                <small>{deal.predictedShipAt ? formatMoscowDateTime(deal.predictedShipAt) : 'нет прогноза даты'}</small>
                              </div>
                            </div>
                          );
                        })}
                        {row.deals.length > 8 && (
                          <button
                            type="button"
                            className="revenue-forecast-more"
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedRows((current) => ({ ...current, [row.id]: !isExpanded }))}
                          >
                            {isExpanded ? 'свернуть список' : `и ещё ${formatNumber(hiddenDealsCount)}`}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cyclePalette = [
  '#466a9f',
  '#2f7d7a',
  '#4f7d58',
  '#8a7242',
  '#a06044',
  '#9b4f64',
  '#6d5a99',
  '#4f7894',
  '#6f744c',
  '#5f6b73',
];

function DealCycleReport({ amoDomain, result }: { amoDomain: string; result: Record<string, any> }) {
  const isCurrentStageAge = result.type === 'dealStageAge';
  const rows = ((result.rows ?? []) as DealCycleRow[]).filter((row) => row.totalDeals > 0 || hasCycleData(row));
  const summary = result.summary as DealCycleRow | undefined;
  const stages = ((result.stages ?? []) as Array<{ stageId: string; stageName: string; color?: string | null }>);

  if (rows.length === 0 && !hasCycleData(summary)) {
    return (
      <div className="muted text-sm">
        {isCurrentStageAge ? 'Сейчас нет открытых сделок в выбранной воронке.' : 'За выбранный период нет завершённых переходов по этапам.'}
      </div>
    );
  }

  return (
    <div className="deal-cycle-report">
      <div className={`deal-cycle-grid deal-cycle-head${isCurrentStageAge ? ' deal-cycle-grid-current' : ''}`}>
        <div>Менеджер</div>
        <div>{isCurrentStageAge ? 'Сейчас в этапах' : 'Этапы сделки'}</div>
        {isCurrentStageAge && <div>Сумма</div>}
        {!isCurrentStageAge && (
          <>
            <div>До успеха</div>
            <div>До отказа</div>
          </>
        )}
      </div>
      <div className="deal-cycle-rows">
        {rows.map((row) => (
          <DealCycleTimelineRow amoDomain={amoDomain} key={row.managerId} row={row} showFinals={!isCurrentStageAge} />
        ))}
        {summary && <DealCycleTimelineRow amoDomain={amoDomain} row={summary} showFinals={!isCurrentStageAge} summary />}
      </div>
      {stages.length > 0 && (
        <div className="deal-cycle-legend">
          {stages.map((stage, index) => (
            <span key={stage.stageId} className="deal-cycle-legend-item" title={stage.stageName}>
              <span style={{ backgroundColor: cycleColor(stage.color, index) }} />
              {stage.stageName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DealCycleTimelineRow({
  amoDomain,
  row,
  showFinals,
  summary = false,
}: {
  amoDomain: string;
  row: DealCycleRow;
  showFinals: boolean;
  summary?: boolean;
}) {
  const stages = row.stages.filter((stage) => stage.sampleSize > 0 && stage.avgDays !== null);
  const isCurrentStageAge = !showFinals;
  const emptyLabel = isCurrentStageAge ? 'нет текущих сделок' : 'нет завершённых переходов';
  return (
    <div className={`deal-cycle-grid deal-cycle-row${showFinals ? '' : ' deal-cycle-grid-current'}${summary ? ' deal-cycle-summary' : ''}`}>
      <div className="deal-cycle-manager" title={row.managerName}>
        <span>{row.managerName}</span>
        <small>{formatNumber(row.totalDeals)} сделок</small>
      </div>
      <div className="deal-cycle-track" aria-label={`Цикл сделки: ${row.managerName}`}>
        {stages.length === 0 ? (
          <div className="deal-cycle-empty">{emptyLabel}</div>
        ) : (
          stages.map((stage) => {
            const label = formatDurationFromDays(stage.avgDays);
            const stageIndex = row.stages.findIndex((item) => item.stageId === stage.stageId);
            return (
              <div
                key={stage.stageId}
                className="deal-cycle-segment"
                tabIndex={0}
                style={{
                  backgroundColor: cycleColor(stage.color, stageIndex),
                  flexGrow: Math.max(Number(stage.avgDays ?? 0), 0.05),
                }}
                title={`${stage.stageName}: ${label}, сделок: ${stage.sampleSize}`}
              >
                <span>{stage.stageName}</span>
                <strong>{label}</strong>
                <div className="deal-cycle-tooltip">
                  <div className="deal-cycle-tooltip-title">{stage.stageName}</div>
                  <div className="deal-cycle-tooltip-meta">В расчёте: {formatNumber(stage.sampleSize)} сделок</div>
                  <div className="deal-cycle-tooltip-list">
                    {(stage.samples ?? []).map((sample, sampleIndex) => {
                      const dealUrl = buildAmoDealUrl(amoDomain, sample.dealExternalId);
                      return (
                      <div key={`${stage.stageId}-${sample.dealId}-${sampleIndex}`} className="deal-cycle-tooltip-row">
                        {dealUrl ? (
                          <a className="deal-cycle-tooltip-link" href={dealUrl} target="_blank" rel="noreferrer" title={sample.dealTitle}>
                            {sample.dealTitle}
                          </a>
                        ) : (
                          <span title={sample.dealTitle}>{sample.dealTitle}</span>
                        )}
                        <strong>{formatDurationFromDays(sample.durationDays)}</strong>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      {isCurrentStageAge && (
        <DealCycleValue label="Сумма" value={row.stageTotal ?? row.overallAverage} />
      )}
      {showFinals && (
        <>
          <DealCycleValue label="До успеха" value={row.successCycle} />
          <DealCycleValue label="До отказа" value={row.lostCycle} />
        </>
      )}
    </div>
  );
}

function buildAmoDealUrl(domain: string, externalId?: string) {
  const cleanDomain = domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!cleanDomain || !externalId) return '';
  return `https://${cleanDomain}/leads/detail/${externalId}`;
}

function DealCycleValue({ label, value }: { label: string; value?: { avgDays: number | null; sampleSize: number } }) {
  const valueLabel = value?.avgDays == null ? 'нет данных' : formatDurationFromDays(value.avgDays);
  return (
    <div className="deal-cycle-value" title={`Сделок: ${value?.sampleSize ?? 0}`}>
      <span className="deal-cycle-value-label">{label}</span>
      <strong>{valueLabel}</strong>
      <span>{formatNumber(value?.sampleSize ?? 0)} сделок</span>
    </div>
  );
}

function hasCycleData(row?: DealCycleRow) {
  if (!row) return false;
  return (
    row.stages?.some((stage) => stage.sampleSize > 0 && stage.avgDays !== null) ||
    Boolean(row.successCycle?.sampleSize) ||
    Boolean(row.lostCycle?.sampleSize)
  );
}

function cycleColor(_value: string | null | undefined, index: number) {
  return cyclePalette[index % cyclePalette.length];
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
  const isWideReport = isWideMetric(config.metric);
  return {
    ...item,
    config: {
      ...config,
      filters: config.filters ?? getInitialFilters(),
      metric: config.metric ?? 'count',
      display: config.display ?? defaultDisplayForMetric(config.metric),
      denominator: config.denominator ?? 'previous',
      pinned: Boolean(layoutItem?.pinned ?? config.pinned ?? false),
      size: isWideReport ? undefined : layoutItem?.size ?? config.size ?? 'md',
      order: Number(layoutItem?.order ?? config.order ?? item.position ?? 0),
    },
  };
}

function orderTemplates(items: ReportTemplate[]) {
  return [...items].sort((a, b) => Number(a.config.order ?? 0) - Number(b.config.order ?? 0));
}

function dashboardSectionKey(template: ReportTemplate) {
  if (template.config.metric === 'revenue_profit_forecast') return 'forecast';
  if (template.config.dashboardSection === 'csm' || template.name.trim().toLowerCase().startsWith('csm:')) return 'csm';
  return 'sales';
}

function upsertTemplate(items: ReportTemplate[], next: ReportTemplate) {
  const exists = items.some((item) => item.id === next.id);
  if (!exists) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

function buildLayoutConfig(templates: ReportTemplate[]) {
  return {
    reports: Object.fromEntries(
      templates.map((template, index) => {
        const layoutItem: { pinned: boolean; order: number; size?: WidgetSize } = {
          pinned: Boolean(template.config.pinned),
          order: Number(template.config.order ?? index + 1),
        };
        if (!isWideMetric(template.config.metric)) layoutItem.size = template.config.size ?? 'md';
        return [template.id, layoutItem];
      }),
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
    const restored = {
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
    return {
      ...restored,
      contractMetrics: restored.contractMetrics.map((metric) => ({
        ...metric,
        extraFilters: metric.extraFilters ?? restoreContractFilters(metric as unknown as ContractMetricPayload),
      })),
    };
  }
  if (template.config.contract) {
    return {
      ...getDefaultDraft(),
      mode: 'contract',
      name: template.name,
      description: template.config.description ?? '',
      entity: template.config.contract.entity ?? 'deal',
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
        formula: metric.formula ?? '',
        successStageId: metric.successStageId ?? '',
        successStageByPipelineId: metric.successStageByPipelineId,
        defaultProbability: metric.defaultProbability,
        extraFilters: restoreContractFilters(metric),
      })),
      contractConversions: template.config.contract.conversions ?? [],
      contractDurations: template.config.contract.durations ?? [],
      visibleUserIds: template.config.visibleUserIds ?? [],
      includeRowTotal: Boolean(template.config.contract.includeRowTotal),
      rowTotalMode: template.config.contract.rowTotalMode ?? 'sum',
      includeSummaryRow: Boolean(template.config.contract.includeSummaryRow ?? true),
      summaryRowMode: template.config.contract.summaryRowMode ?? 'sum',
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

function restoreContractFilters(metric: ContractMetricPayload): ContractFilterDraft[] {
  const filters = (metric.extraFilters ?? []).map((filter) => ({
    id: filter.id ?? makeId('filter'),
    subject: filter.subject,
    fieldId: filter.fieldId ?? '',
    operator: filter.operator,
    value: String(filter.value ?? ''),
    amount: filter.amount ?? 1,
    unit: filter.unit ?? 'days',
  }));

  const legacyMetric = metric as ContractMetricPayload & {
    createdWithinAmount?: number;
    createdWithinUnit?: RelativeUnit;
    lastNoteOlderThanAmount?: number;
    lastNoteOlderThanUnit?: RelativeUnit;
  };
  if (legacyMetric.createdWithinAmount && legacyMetric.createdWithinAmount > 0) {
    filters.push({
      id: makeId('filter'),
      subject: 'deal_created_at',
      fieldId: '',
      operator: 'within_last',
      value: '',
      amount: legacyMetric.createdWithinAmount,
      unit: legacyMetric.createdWithinUnit ?? 'days',
    });
  }
  if (legacyMetric.lastNoteOlderThanAmount && legacyMetric.lastNoteOlderThanAmount > 0) {
    filters.push({
      id: makeId('filter'),
      subject: 'last_note_created_at',
      fieldId: '',
      operator: 'older_than',
      value: '',
      amount: legacyMetric.lastNoteOlderThanAmount,
      unit: legacyMetric.lastNoteOlderThanUnit ?? 'hours',
    });
  }
  return filters;
}

