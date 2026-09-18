import { CrmControlRuleInput, CrmControlRuleResult, CrmControlResultStatus } from './crm-control.types';

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
  proposal_note: 'Обоснование переноса презентации КП',
  deal_age: 'Возраст сделки',
  offer_budget: 'Сумма предложения и бюджет',
  proposal_file: 'Последняя отправленная версия КП',
  price_requested_duration: 'Срок получения цены',
} as const;

export const CRM_CONTROL_RULE_CATALOG: Array<{ code: string; name: string; clauses: string[]; mode: 'automatic' | 'review' }> = [
  { code: 'intake_stage', name: RULE_NAMES.intake_stage, clauses: ['ОПНК 1', 'ОППК 1'], mode: 'automatic' },
  { code: 'task_deadline', name: RULE_NAMES.task_deadline, clauses: ['ОПНК 2', 'ОПНК 3', 'ОППК 2', 'ОППК 3'], mode: 'automatic' },
  { code: 'task_count', name: RULE_NAMES.task_count, clauses: ['ОПНК 5', 'ОППК 4', 'ОППК 6'], mode: 'automatic' },
  { code: 'task_type', name: RULE_NAMES.task_type, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'automatic' },
  { code: 'task_text', name: RULE_NAMES.task_text, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'review' },
  { code: 'task_stage_deadline', name: RULE_NAMES.task_stage_deadline, clauses: ['ОПНК 5', 'ОППК 6'], mode: 'automatic' },
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

function civilTime(date: Date, formatter: Intl.DateTimeFormat) {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  // This value compares wall-clock dates in one time zone; it is not a UTC instant.
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second, date.getUTCMilliseconds());
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
  const activeTasks = [...new Map(input.tasks.filter((task) => !task.isCompleted).map((task) => [taskSubject(task), task])).values()];

  const intakeStageId = sales ? scope.assignedStageId : scope.newClientStageId;
  if (!intakeStageId) {
    add('intake_stage', 'UNKNOWN', 'Не выбран начальный этап для проверки.');
  } else if (deal.stageId !== intakeStageId) {
    add('intake_stage', 'NA', 'Сделка находится на другом этапе.', { details: { resolvesPrior: true } });
  } else if (beforeDayEnd) {
    add('intake_stage', 'UNKNOWN', 'Итог рабочего дня ещё не наступил. Этот пункт проверяется после 19:00.');
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
      add(code, 'UNKNOWN', 'Список задач неполный или не подтверждена его актуальность.');
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
            { subjectId, clauses: [`${department} 2`], details: { ...taskDetails, dueToday, overdue } });
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
      if (!allowedTypes?.length || allowedTypes.some((type) => !Number.isInteger(type))) {
        add('task_type', 'UNKNOWN', 'Для этапа не утверждены допустимые типы задач.', { subjectId, details: taskDetails });
      } else {
        const allowed = task.typeId !== null && allowedTypes.includes(task.typeId);
        add('task_type', allowed ? 'PASS' : 'FAIL', allowed ? 'Тип задачи соответствует нормативу этапа.' : 'Тип задачи не входит в допустимые для этого этапа.',
          { subjectId, details: { ...taskDetails, actualTypeId: task.typeId, allowedTypeIds: allowedTypes } });
      }

      add('task_text', taskText(task) ? 'REVIEW' : 'FAIL', taskText(task)
        ? 'Нужно проверить, описывает ли текст задачи следующий шаг по этой сделке.'
        : 'В открытой задаче отсутствует текст следующего действия.', { subjectId, details: taskDetails });

      const duration = stageRule?.maxDurationHours;
      if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
        add('task_stage_deadline', 'UNKNOWN', 'Для этапа не утверждён предельный срок.', { subjectId, details: taskDetails });
      } else if (!stageEnteredAt || !dueAt) {
        add('task_stage_deadline', 'UNKNOWN', 'Неизвестно время входа в этап или срок задачи.', { subjectId, details: taskDetails });
      } else {
        const limit = new Date(stageEnteredAt.getTime() + duration * 3_600_000);
        if (!validDate(limit)) {
          add('task_stage_deadline', 'UNKNOWN', 'Предельный срок этапа выходит за допустимый диапазон дат.', { subjectId, details: taskDetails });
          continue;
        }
        const details = { ...taskDetails, stageEnteredAt: stageEnteredAt.toISOString(), maximumDueAt: limit.toISOString(), maxDurationHours: duration };
        if (dueAt <= limit) {
          add('task_stage_deadline', 'PASS', 'Срок задачи не превышает норматив этапа.', { subjectId, details });
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

  if (!scope.preparedProposalStageId) {
    add('proposal_note', 'UNKNOWN', 'Не выбран этап «КП подготовлено».');
  } else if (deal.stageId !== scope.preparedProposalStageId) {
    add('proposal_note', 'NA', 'Сделка не на этапе «КП подготовлено».', { details: { resolvesPrior: true } });
  } else if (beforeDayEnd) {
    add('proposal_note', 'UNKNOWN', 'Итог рабочего дня ещё не наступил: презентация КП или примечание о переносе ещё могут быть оформлены сегодня.');
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

  if (base && config.excludeBaseFromAge) {
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

  add('offer_budget', 'UNKNOWN', 'Не подключён достоверный источник суммы предложения, фактически отправленного клиенту. Нужна ручная сверка.');
  add('proposal_file', 'UNKNOWN', 'Не подключено сопоставление всех файлов поля «КП» с последней версией, фактически отправленной клиенту. Нужна ручная сверка.');

  if (sales) {
    add('price_requested_duration', 'NA', 'Пункт относится к ОППК.', { details: { resolvesPrior: true } });
  } else if (!scope.priceRequestedStageId) {
    add('price_requested_duration', 'UNKNOWN', 'Не выбран этап «Цена запрошена».');
  } else if (deal.stageId !== scope.priceRequestedStageId) {
    add('price_requested_duration', 'NA', 'Сделка не на этапе «Цена запрошена».', { details: { resolvesPrior: true } });
  } else if (!stageEnteredAt) {
    add('price_requested_duration', 'UNKNOWN', 'Неизвестно достоверное время входа в этап «Цена запрошена».');
  } else {
    const elapsedHours = (observedAt.getTime() - stageEnteredAt.getTime()) / 3_600_000;
    const details = { stageEnteredAt: stageEnteredAt.toISOString(), elapsedHours, allowedHours: 24 };
    if (elapsedHours <= 24) {
      add('price_requested_duration', 'PASS', 'С момента входа в «Цена запрошена» прошло не больше 24 часов.', { details });
    } else {
      const noteState = currentNotes(false);
      const communications = (input.communications ?? []).filter((item) => {
        const date = validDate(item.createdAt);
        return !!date && date >= stageEnteredAt && date <= observedAt;
      });
      if (noteState.notes.length || communications.length) {
        add('price_requested_duration', 'REVIEW', 'Цена запрошена больше 24 часов назад. Нужно проверить, подтверждают ли приложенные записи допустимую задержку.',
          { details: { ...details, noteIds: noteState.notes.map((note) => note.externalId || note.id), communicationIds: communications.map((item) => item.id) } });
      } else if (!sourceCompleteness.notes || !sourceCompleteness.communications || noteState.invalid || (input.communications ?? []).some((item) => !validDate(item.createdAt))) {
        add('price_requested_duration', 'UNKNOWN', 'Прошло больше 24 часов, но доступность всех подтверждений задержки не установлена.', { details });
      } else {
        add('price_requested_duration', 'FAIL', 'Цена запрошена больше 24 часов назад; подтверждения допустимой задержки не найдено.', { details });
      }
    }
  }

  return results;
}
