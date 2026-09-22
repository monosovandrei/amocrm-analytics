import { CrmControlRuleInput, CrmControlRuleResult, CrmControlResultStatus } from './crm-control.types';
import { civilTime, stageDeadline } from './crm-control-deadline';

export const CRM_CONTROL_RULE_VERSION = '4';

type RuleCode = keyof typeof RULE_NAMES;
type ResultExtra = Pick<CrmControlRuleResult, 'subjectId' | 'details'> & { clauses?: string[] };
type Task = CrmControlRuleInput['tasks'][number];

const RULE_NAMES = {
  intake_stage: 'Необработанная сделка',
  task_deadline: 'Задача на сегодня или просрочена',
  task_count: 'Количество открытых задач',
  task_type: 'Тип следующей задачи',
  task_text: 'Содержание следующей задачи',
  task_stage_deadline: 'Срок следующей задачи',
  stage_duration: 'Срок нахождения на этапе',
  proposal_note: 'Обоснование переноса презентации КП',
  deal_age: 'Возраст сделки',
  offer_budget: 'Сумма предложения и бюджет',
  proposal_file: 'Последняя отправленная версия КП',
  price_requested_duration: 'Срок запроса цены',
} as const;

export const CRM_CONTROL_RULE_CATALOG: Array<{ code: string; name: string; clauses: string[]; mode: 'automatic' | 'review' }> = [
  { code: 'intake_stage', name: RULE_NAMES.intake_stage, clauses: ['ОПНК 1', 'ОППК 1'], mode: 'automatic' },
  { code: 'task_deadline', name: RULE_NAMES.task_deadline, clauses: ['ОПНК 2', 'ОПНК 3', 'ОППК 2', 'ОППК 3'], mode: 'automatic' },
  { code: 'task_count', name: RULE_NAMES.task_count, clauses: ['ОПНК 5', 'ОППК 4', 'ОППК 6'], mode: 'automatic' },
  { code: 'task_type', name: RULE_NAMES.task_type, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'automatic' },
  { code: 'task_text', name: RULE_NAMES.task_text, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'review' },
  { code: 'task_stage_deadline', name: RULE_NAMES.task_stage_deadline, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'automatic' },
  { code: 'stage_duration', name: RULE_NAMES.stage_duration, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'automatic' },
  { code: 'proposal_note', name: RULE_NAMES.proposal_note, clauses: ['ОПНК 4', 'ОППК 5'], mode: 'review' },
  { code: 'deal_age', name: RULE_NAMES.deal_age, clauses: ['ОПНК 6', 'ОППК 7'], mode: 'automatic' },
  { code: 'offer_budget', name: RULE_NAMES.offer_budget, clauses: ['ОПНК 7', 'ОППК 8'], mode: 'review' },
  { code: 'proposal_file', name: RULE_NAMES.proposal_file, clauses: ['ОПНК 8', 'ОППК 9'], mode: 'review' },
  { code: 'price_requested_duration', name: RULE_NAMES.price_requested_duration, clauses: ['ОППК 10'], mode: 'automatic' },
];

function validDate(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function taskSubject(task: Task) {
  return task.externalId || task.id;
}

function taskText(task: Task) {
  const raw = task.raw;
  // The sync layer supplies a display title when amoCRM's actual task text is empty.
  if (raw && typeof raw === 'object' && 'text' in raw) {
    return typeof raw.text === 'string' ? raw.text.trim() : '';
  }
  return task.title.trim();
}

function nextCalendarMonth(civil: number) {
  const current = new Date(civil);
  const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(current.getUTCDate(), lastDay),
    current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(), current.getUTCMilliseconds());
}

/** Completeness flags certify both a complete source and freshness at observedAt. */
export function evaluateCrmControlDeal(input: CrmControlRuleInput): CrmControlRuleResult[] {
  const { deal, scope, config, sourceCompleteness } = input;
  const sales = scope.department === 'sales';
  const department = sales ? 'ОПНК' : 'ОППК';
  const taskClause = `${department} ${sales ? 5 : 6}`;
  const clauses: Record<RuleCode, string[]> = {
    intake_stage: [`${department} 1`],
    task_deadline: [`${department} 2`, `${department} 3`],
    task_count: sales ? [taskClause] : ['ОППК 4', taskClause],
    task_type: [taskClause],
    task_text: [taskClause],
    task_stage_deadline: [taskClause],
    stage_duration: [taskClause],
    proposal_note: [`${department} ${sales ? 4 : 5}`],
    deal_age: [`${department} ${sales ? 6 : 7}`],
    offer_budget: [`${department} ${sales ? 7 : 8}`],
    proposal_file: [`${department} ${sales ? 8 : 9}`],
    price_requested_duration: ['ОППК 10'],
  };
  const results: CrmControlRuleResult[] = [];
  const add = (ruleCode: RuleCode, status: CrmControlResultStatus, message: string, extra: ResultExtra = {}) => {
    results.push({ ruleCode, ruleName: RULE_NAMES[ruleCode], status, message, clauses: clauses[ruleCode], ...extra });
  };
  const allUnknown = (message: string) => {
    for (const code of Object.keys(RULE_NAMES) as RuleCode[]) add(code, 'UNKNOWN', message);
    return results;
  };

  const observedAt = validDate(input.observedAt);
  if (!observedAt) return allUnknown('Неизвестно фактическое время проверки.');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return allUnknown('В настройках указан неизвестный часовой пояс.');
  }
  if (!sourceCompleteness.deal) return allUnknown('Нет полного актуального состояния сделки.');
  if (scope.pipelineId !== deal.pipelineId) return allUnknown('Настройки относятся к другой воронке.');

  const observedCivil = civilTime(observedAt, formatter);
  const localDayStart = Math.floor(observedCivil / 86_400_000) * 86_400_000;
  const beforeDayEnd = observedCivil < localDayStart + 19 * 3_600_000;
  const createdAt = validDate(deal.createdAt);
  const entry = validDate(input.stageEnteredAt);
  const stageEnteredAt = sourceCompleteness.stageHistory && entry && entry <= observedAt ? entry : null;
  const base = !sales && !!scope.baseStageId && deal.stageId === scope.baseStageId;
  const stageRule = scope.stageRules?.[deal.stageId];
  const limit = stageDeadline(stageRule, stageEnteredAt, formatter);
  const deadlineDetails = { deadlineMode: limit.mode, timeZone: config.timeZone,
    stageEnteredAt: stageEnteredAt?.toISOString() ?? null, maximumDueAt: limit.deadline?.toISOString() ?? null,
    ...(stageRule?.maxDurationHours != null ? { maxDurationHours: stageRule.maxDurationHours } : {}),
    ...(stageRule?.maxBusinessDays != null ? { maxBusinessDays: stageRule.maxBusinessDays } : {}) };
  const activeTasks = [...new Map(input.tasks.filter((task) => !task.isCompleted).map((task) => [taskSubject(task), task])).values()];

  const intakeStageId = sales ? scope.assignedStageId : scope.newClientStageId;
  if (intakeStageId === null) {
    add('intake_stage', 'NA', 'Владелец указал, что начального этапа для этой проверки в воронке нет.', { details: { configuredAbsent: true } });
  } else if (!intakeStageId) {
    add('intake_stage', 'UNKNOWN', 'Не выбран начальный этап для проверки.');
  } else if (deal.stageId !== intakeStageId) {
    add('intake_stage', 'NA', 'Сделка находится на другом этапе.', { details: { resolvesPrior: true } });
  } else if (beforeDayEnd) {
    add('intake_stage', 'UNKNOWN', 'Итог рабочего дня ещё не наступил. Этот пункт проверяется после 19:00.', { details: { awaitingDayEnd: true } });
  } else if (!sales) {
    add('intake_stage', 'FAIL', 'После окончания рабочего дня сделка осталась на этапе «Новый клиент».');
  } else if (!createdAt || createdAt > observedAt) {
    add('intake_stage', 'UNKNOWN', 'Нет достоверной даты создания сделки.');
  } else {
    const beforeCutoff = civilTime(createdAt, formatter) < localDayStart + 19 * 3_600_000;
    add('intake_stage', beforeCutoff ? 'FAIL' : 'NA', beforeCutoff
      ? 'Созданная до 19:00 сделка осталась на этапе «Назначен ответственный».'
      : 'Сделка создана в 19:00 или позже и не подпадает под этот пункт.',
    { details: { createdAt: createdAt.toISOString(), cutoffLocalTime: '19:00', timeZone: config.timeZone, ...(!beforeCutoff ? { resolvesPrior: true } : {}) } });
  }

  if (!sourceCompleteness.tasks) {
    for (const code of ['task_deadline', 'task_count', 'task_type', 'task_text', 'task_stage_deadline'] as const) {
      if (code === 'task_stage_deadline' && limit.mode === 'unlimited' && !limit.reason) {
        add(code, 'NA', 'Для этапа не установлен предельный срок.', { details: { ...deadlineDetails, resolvesPrior: true, resolvesAllSubjects: true } });
      } else add(code, 'UNKNOWN', 'Список задач неполный или не подтверждена его актуальность.');
    }
  } else {
    const countCorrect = base ? activeTasks.length <= 1 : activeTasks.length === 1;
    add('task_count', countCorrect ? 'PASS' : 'FAIL', countCorrect
      ? (base ? 'На этапе «База» допустимо от нуля до одной открытой задачи.' : 'В сделке одна открытая задача.')
      : `Открытых задач: ${activeTasks.length}. ${base ? 'Допустимо не больше одной.' : 'Должна быть ровно одна.'}`,
    { details: { activeTaskCount: activeTasks.length, taskIds: activeTasks.map(taskSubject), allowedMinimum: base ? 0 : 1, allowedMaximum: 1 } });

    if (activeTasks.length === 0) {
      add('task_deadline', 'PASS', 'Незавершённых задач на сегодня или с истёкшим сроком нет.');
      for (const code of ['task_type', 'task_text', 'task_stage_deadline'] as const) add(code, 'NA', 'Нет открытой задачи для проверки.');
    }

    for (const task of activeTasks) {
      const subjectId = taskSubject(task);
      const dueAt = validDate(task.dueAt);
      const taskDetails = { taskId: subjectId, taskText: taskText(task), dueAt: dueAt?.toISOString() ?? null };
      if (!dueAt) {
        add('task_deadline', 'UNKNOWN', 'Неизвестен срок открытой задачи.', { subjectId, details: taskDetails });
      } else {
        const dueToday = Math.floor(civilTime(dueAt, formatter) / 86_400_000) * 86_400_000 === localDayStart;
        const overdue = dueAt < observedAt;
        if (dueToday && !overdue && beforeDayEnd) {
          add('task_deadline', 'UNKNOWN', 'Задача назначена на сегодня, но срок ещё не истёк и итог рабочего дня не наступил.',
            { subjectId, clauses: [`${department} 2`], details: { ...taskDetails, dueToday, overdue, awaitingDayEnd: true } });
        } else {
          const failedClauses = [...(dueToday && !beforeDayEnd ? [`${department} 2`] : []), ...(overdue ? [`${department} 3`] : [])];
          add('task_deadline', dueToday || overdue ? 'FAIL' : 'PASS', dueToday && overdue
            ? 'Незавершённая задача на сегодня уже просрочена.'
            : dueToday ? 'Осталась незавершённая задача на сегодня.'
              : overdue ? 'Осталась просроченная задача.' : 'Срок задачи ещё не наступил и назначен не на сегодня.',
          { subjectId, clauses: failedClauses.length ? failedClauses : clauses.task_deadline, details: { ...taskDetails, dueToday, overdue } });
        }
      }

      const allowedTypes = stageRule?.allowedTaskTypeIds;
      if (base && !allowedTypes?.length) {
        add('task_type', 'NA', 'На этапе «База» регламент не ограничивает тип задачи.', { subjectId, details: { ...taskDetails, resolvesPrior: true } });
      } else if (!allowedTypes?.length || allowedTypes.some((type) => !Number.isInteger(type))) {
        add('task_type', 'UNKNOWN', 'Для этапа не утверждены допустимые типы задач.', { subjectId, details: taskDetails });
      } else {
        const allowed = task.typeId !== null && allowedTypes.includes(task.typeId);
        add('task_type', allowed ? 'PASS' : 'FAIL', allowed ? 'Тип задачи соответствует нормативу этапа.' : 'Тип задачи не входит в допустимые для этого этапа.',
          { subjectId, details: { ...taskDetails, actualTypeId: task.typeId, allowedTypeIds: allowedTypes } });
      }

      add('task_text', taskText(task) ? 'REVIEW' : 'FAIL', taskText(task)
        ? 'Нужно проверить, описывает ли текст задачи следующий шаг по этой сделке.'
        : 'В открытой задаче отсутствует текст следующего действия.', { subjectId, details: taskDetails });

      const details = { ...taskDetails, ...deadlineDetails };
      if (limit.mode === 'unlimited' && !limit.reason) {
        add('task_stage_deadline', 'NA', 'Для этапа не установлен предельный срок.', { subjectId, details: { ...details, resolvesPrior: true } });
      } else if (!limit.deadline || !dueAt) {
        add('task_stage_deadline', 'UNKNOWN', limit.reason ?? 'Неизвестен срок задачи.', { subjectId, details });
      } else {
        if (dueAt <= limit.deadline) {
          add('task_stage_deadline', 'PASS', 'Срок задачи не превышает норматив этапа.', { subjectId, details });
        } else if (limit.mode === 'end_of_day') {
          add('task_stage_deadline', 'FAIL', 'Срок задачи позже 19:00 даты входа в этап. Примечания не отменяют этот норматив.', { subjectId, details });
        } else {
          const noteState = currentNotes(true);
          if (noteState.invalid || !sourceCompleteness.notes) {
            add('task_stage_deadline', 'UNKNOWN', 'Срок задачи превышает норматив, но примечания об исключениях прочитаны не полностью.', { subjectId, details });
          } else if (noteState.notes.length === 0) {
            add('task_stage_deadline', 'FAIL', 'Срок задачи превышает норматив этапа; актуального примечания менеджера о договорённости нет.', { subjectId, details });
          } else {
            add('task_stage_deadline', 'REVIEW', 'Срок задачи превышает норматив. Нужно проверить примечание и подтверждение согласованного срока в звонке или сообщении.',
              { subjectId, details: { ...details, noteIds: noteState.notes.map((note) => note.externalId || note.id) } });
          }
        }
      }
    }
  }

  function currentNotes(managerOnly: boolean) {
    const candidates = input.notes.filter((note) => !managerOnly || note.type === 'common');
    const invalid = !stageEnteredAt || candidates.some((note) => !validDate(note.createdAt));
    const notes = candidates.filter((note) => {
      const date = validDate(note.createdAt);
      return !!stageEnteredAt && !!date && date >= stageEnteredAt && date <= observedAt! && (!managerOnly || !!note.text?.trim());
    });
    return { notes, invalid };
  }

  if (!sales && scope.priceRequestedStageId && deal.stageId === scope.priceRequestedStageId) {
    add('stage_duration', 'NA', 'Срок этого этапа учитывается в проверке «Срок запроса цены».',
      { details: { delegatedTo: 'price_requested_duration', resolvesPrior: true } });
  } else if (limit.mode === 'unlimited' && !limit.reason) {
    add('stage_duration', 'NA', 'Для этапа не установлен предельный срок.', { details: { ...deadlineDetails, resolvesPrior: true } });
  } else if (!limit.deadline) {
    add('stage_duration', 'UNKNOWN', limit.reason!, { details: deadlineDetails });
  } else {
    const details = { ...deadlineDetails, elapsedHours: (observedAt.getTime() - stageEnteredAt!.getTime()) / 3_600_000 };
    const exceeded = limit.mode === 'end_of_day' ? observedAt >= limit.deadline : observedAt > limit.deadline;
    if (!exceeded) add('stage_duration', 'PASS', 'Предельный срок нахождения сделки на этапе ещё не превышен.', { details });
    else if (limit.mode === 'end_of_day') {
      add('stage_duration', 'FAIL', 'Сделка осталась на этапе в 19:00 даты входа или позже. Примечания не отменяют этот норматив.', { details });
    } else {
      const noteState = currentNotes(true);
      if (noteState.invalid || !sourceCompleteness.notes) {
        add('stage_duration', 'UNKNOWN', 'Срок нахождения на этапе превышен, но примечания об исключениях прочитаны не полностью.', { details });
      } else if (!noteState.notes.length) {
        add('stage_duration', 'FAIL', 'Срок нахождения на этапе превышен; актуального примечания менеджера о договорённости нет.', { details });
      } else {
        add('stage_duration', 'REVIEW', 'Срок нахождения на этапе превышен. Нужно проверить примечание и подтверждение договорённости с клиентом.',
          { details: { ...details, noteIds: noteState.notes.map((note) => note.externalId || note.id) } });
      }
    }
  }

  if (scope.preparedProposalStageId === null) {
    add('proposal_note', 'NA', 'Владелец указал, что этапа «КП подготовлено» в воронке нет.', { details: { configuredAbsent: true } });
  } else if (!scope.preparedProposalStageId) {
    add('proposal_note', 'UNKNOWN', 'Не выбран этап «КП подготовлено».');
  } else if (deal.stageId !== scope.preparedProposalStageId) {
    add('proposal_note', 'NA', 'Сделка не на этапе «КП подготовлено».', { details: { resolvesPrior: true } });
  } else if (beforeDayEnd) {
    add('proposal_note', 'UNKNOWN', 'Итог рабочего дня ещё не наступил: презентация КП или примечание о переносе ещё могут быть оформлены сегодня.', { details: { awaitingDayEnd: true } });
  } else {
    const noteState = currentNotes(true);
    const hasManagerText = input.notes.some((note) => note.type === 'common' && !!note.text?.trim());
    if (!sourceCompleteness.notes) {
      add('proposal_note', 'UNKNOWN', 'Нельзя достоверно проверить актуальное примечание: неполные данные или неизвестно время входа в этап.');
    } else if (!hasManagerText) {
      add('proposal_note', 'FAIL', 'В сделке нет текстового примечания менеджера с причиной переноса и датой презентации.');
    } else if (noteState.invalid) {
      add('proposal_note', 'UNKNOWN', 'Неизвестна дата примечания или время входа в текущий этап; актуальность примечания не установлена.');
    } else if (noteState.notes.length === 0) {
      add('proposal_note', 'FAIL', 'После входа в «КП подготовлено» нет примечания менеджера с причиной переноса и датой презентации.');
    } else {
      add('proposal_note', 'REVIEW', 'Нужно проверить причину переноса, дату презентации и связь примечания с текущим КП.',
        { details: { noteIds: noteState.notes.map((note) => note.externalId || note.id), stageEnteredAt: stageEnteredAt!.toISOString() } });
    }
  }

  if (scope.checkDealAge === false) {
    add('deal_age', 'NA', 'Для этой воронки ограничение возраста сделки отключено.', { details: { resolvesPrior: true } });
  } else if (base && config.excludeBaseFromAge) {
    add('deal_age', 'NA', 'Этап «База» исключён из ограничения возраста сделки.', { details: { resolvesPrior: true } });
  } else if (!createdAt || createdAt > observedAt) {
    add('deal_age', 'UNKNOWN', 'Нет достоверной даты создания сделки.');
  } else {
    const old = config.maxDealAge === '30_days'
      ? observedAt.getTime() - createdAt.getTime() > 30 * 86_400_000
      : observedCivil > nextCalendarMonth(civilTime(createdAt, formatter));
    add('deal_age', old ? 'FAIL' : 'PASS', old ? 'Возраст сделки превышает установленный месяц.' : 'Возраст сделки не превышает установленный месяц.',
      { details: { createdAt: createdAt.toISOString(), agePolicy: config.maxDealAge, timeZone: config.timeZone } });
  }

  add('offer_budget', 'UNKNOWN', 'Ожидается автоматическое сравнение бюджета с итогом сохранённого отправленного КП.');
  add('proposal_file', 'UNKNOWN', 'Ожидается автоматическое сравнение файлов поля «КП» с сохранённой отправленной версией.');

  if (sales) {
    add('price_requested_duration', 'NA', 'Пункт относится к ОППК.', { details: { resolvesPrior: true } });
  } else if (scope.priceRequestedStageId === null) {
    add('price_requested_duration', 'NA', 'Владелец указал, что этапа «Цена запрошена» в воронке нет.', { details: { configuredAbsent: true } });
  } else if (!scope.priceRequestedStageId) {
    add('price_requested_duration', 'UNKNOWN', 'Не выбран этап «Цена запрошена».');
  } else if (deal.stageId !== scope.priceRequestedStageId) {
    add('price_requested_duration', 'NA', 'Сделка не на этапе «Цена запрошена».', { details: { resolvesPrior: true } });
  } else {
    const hasConfiguredLimit = stageRule?.deadlineMode !== undefined || stageRule?.maxDurationHours != null || stageRule?.maxBusinessDays != null;
    const priceLimit = hasConfiguredLimit ? limit : stageDeadline({ maxDurationHours: 24 }, stageEnteredAt, formatter);
    const details = { ...deadlineDetails, deadlineMode: priceLimit.mode, maximumDueAt: priceLimit.deadline?.toISOString() ?? null,
      ...(!hasConfiguredLimit ? { maxDurationHours: 24 } : {}),
      elapsedHours: stageEnteredAt ? (observedAt.getTime() - stageEnteredAt.getTime()) / 3_600_000 : null };
    if (priceLimit.mode === 'unlimited' && !priceLimit.reason) {
      add('price_requested_duration', 'NA', 'Для запроса цены явно отключён предельный срок.', { details: { ...details, resolvesPrior: true } });
    } else if (!priceLimit.deadline || !stageEnteredAt) {
      add('price_requested_duration', 'UNKNOWN', priceLimit.reason ?? 'Неизвестно достоверное время входа в этап «Цена запрошена».', { details });
    } else if (priceLimit.mode === 'end_of_day' ? observedAt < priceLimit.deadline : observedAt <= priceLimit.deadline) {
      add('price_requested_duration', 'PASS', 'Предельный срок запроса цены ещё не превышен.', { details });
    } else if (priceLimit.mode === 'end_of_day') {
      add('price_requested_duration', 'FAIL', 'Цена не получена к 19:00 даты входа в этап. Примечания не отменяют этот норматив.', { details });
    } else {
      const noteState = currentNotes(false);
      const communications = (input.communications ?? []).filter((item) => {
        const date = validDate(item.createdAt);
        return !!date && date >= stageEnteredAt && date <= observedAt;
      });
      if (noteState.notes.length || communications.length) {
        add('price_requested_duration', 'REVIEW', 'Срок запроса цены превышен. Нужно проверить, подтверждают ли приложенные записи допустимую задержку.',
          { details: { ...details, noteIds: noteState.notes.map((note) => note.externalId || note.id), communicationIds: communications.map((item) => item.id) } });
      } else if (!sourceCompleteness.notes || !sourceCompleteness.communications || noteState.invalid || (input.communications ?? []).some((item) => !validDate(item.createdAt))) {
        add('price_requested_duration', 'UNKNOWN', 'Срок запроса цены превышен, но доступность всех подтверждений задержки не установлена.', { details });
      } else {
        add('price_requested_duration', 'FAIL', 'Срок запроса цены превышен; подтверждения допустимой задержки не найдено.', { details });
      }
    }
  }

  return results;
}
