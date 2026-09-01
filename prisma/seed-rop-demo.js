const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

const {
  PlatformBusinessRole,
  PrismaClient,
  QualitySeverity,
  UserRole,
} = require('../apps/api/src/generated/prisma');

const prisma = new PrismaClient();

const demoPrefix = 'rop-demo';
const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'rop-demo@example.local').toLowerCase();
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'RopDemo123!';

function daysAgo(days, hour = 12) {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date;
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3_600_000);
}

function externalId(suffix) {
  return `${demoPrefix}-${suffix}`;
}

async function upsertStage(pipelineId, data) {
  return prisma.pipelineStage.upsert({
    where: {
      pipelineId_externalId: {
        pipelineId,
        externalId: data.externalId,
      },
    },
    create: {
      ...data,
      pipelineId,
    },
    update: data,
  });
}

async function resetDemoData() {
  const demoDeals = await prisma.deal.findMany({
    where: { externalId: { startsWith: externalId('deal-') } },
    select: { id: true },
  });
  const demoDealIds = demoDeals.map((deal) => deal.id);

  await prisma.qualityViolation.deleteMany({
    where: {
      OR: [
        { dealId: { in: demoDealIds } },
        { rule: { code: { startsWith: externalId('rule-') } } },
      ],
    },
  });
  await prisma.task.deleteMany({ where: { externalId: { startsWith: externalId('task-') } } });
  await prisma.note.deleteMany({ where: { externalId: { startsWith: externalId('note-') } } });
  await prisma.crmEvent.deleteMany({ where: { externalId: { startsWith: externalId('event-') } } });
  if (demoDealIds.length) {
    await prisma.emailThreadDismissal.deleteMany({ where: { dealId: { in: demoDealIds } } });
    await prisma.emailThreadState.deleteMany({ where: { dealId: { in: demoDealIds } } });
    await prisma.dealStageHistory.deleteMany({ where: { dealId: { in: demoDealIds } } });
    await prisma.deal.deleteMany({ where: { id: { in: demoDealIds } } });
  }
}

async function main() {
  await resetDemoData();

  await prisma.amoAccountSnapshot.upsert({
    where: { externalId: externalId('account') },
    create: {
      externalId: externalId('account'),
      name: 'Локальный демо-аккаунт',
      subdomain: 'example.amocrm.ru',
      raw: { demo: true },
    },
    update: {
      name: 'Локальный демо-аккаунт',
      subdomain: 'example.amocrm.ru',
      raw: { demo: true },
    },
  });

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      name: 'Локальный РОП',
      role: UserRole.ADMIN,
      businessRole: PlatformBusinessRole.OWNER,
      passwordHash,
      isActive: true,
    },
    update: {
      name: 'Локальный РОП',
      role: UserRole.ADMIN,
      businessRole: PlatformBusinessRole.OWNER,
      passwordHash,
      isActive: true,
    },
  });

  const salesGroup = await prisma.crmGroup.upsert({
    where: { externalId: externalId('group-sales') },
    create: { externalId: externalId('group-sales'), name: 'Sales', isVisible: true, raw: { demo: true } },
    update: { name: 'Sales', isVisible: true, raw: { demo: true } },
  });
  const csmGroup = await prisma.crmGroup.upsert({
    where: { externalId: externalId('group-csm') },
    create: { externalId: externalId('group-csm'), name: 'CSM', isVisible: true, raw: { demo: true } },
    update: { name: 'CSM', isVisible: true, raw: { demo: true } },
  });

  const [anna, boris, vera, gleb] = await Promise.all([
    prisma.crmUser.upsert({
      where: { externalId: externalId('user-anna') },
      create: { externalId: externalId('user-anna'), name: 'Анна Смирнова', email: 'anna@example.local', groupId: salesGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
      update: { name: 'Анна Смирнова', groupId: salesGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
    }),
    prisma.crmUser.upsert({
      where: { externalId: externalId('user-boris') },
      create: { externalId: externalId('user-boris'), name: 'Борис Климов', email: 'boris@example.local', groupId: salesGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
      update: { name: 'Борис Климов', groupId: salesGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
    }),
    prisma.crmUser.upsert({
      where: { externalId: externalId('user-vera') },
      create: { externalId: externalId('user-vera'), name: 'Вера Орлова', email: 'vera@example.local', groupId: csmGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
      update: { name: 'Вера Орлова', groupId: csmGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
    }),
    prisma.crmUser.upsert({
      where: { externalId: externalId('user-gleb') },
      create: { externalId: externalId('user-gleb'), name: 'Глеб Морозов', email: 'gleb@example.local', groupId: salesGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
      update: { name: 'Глеб Морозов', groupId: salesGroup.id, isActive: true, isVisible: true, raw: { demo: true } },
    }),
  ]);

  const salesPipeline = await prisma.pipeline.upsert({
    where: { externalId: externalId('pipeline-sales') },
    create: { externalId: externalId('pipeline-sales'), name: 'Продажи Demo', isArchived: false, raw: { demo: true } },
    update: { name: 'Продажи Demo', isArchived: false, raw: { demo: true } },
  });
  const csmPipeline = await prisma.pipeline.upsert({
    where: { externalId: externalId('pipeline-csm') },
    create: { externalId: externalId('pipeline-csm'), name: 'CSM Demo', isArchived: false, raw: { demo: true } },
    update: { name: 'CSM Demo', isArchived: false, raw: { demo: true } },
  });

  const salesStages = {
    newLead: await upsertStage(salesPipeline.id, { externalId: externalId('stage-sales-new'), name: 'Новый лид', position: 10, color: '#2563eb', isWon: false, isLost: false, isVisible: true, raw: { demo: true } }),
    qualify: await upsertStage(salesPipeline.id, { externalId: externalId('stage-sales-qualify'), name: 'Квалификация', position: 20, color: '#0f9f6e', isWon: false, isLost: false, isVisible: true, raw: { demo: true } }),
    proposal: await upsertStage(salesPipeline.id, { externalId: externalId('stage-sales-proposal'), name: 'КП отправлено', position: 30, color: '#d88a13', isWon: false, isLost: false, isVisible: true, raw: { demo: true } }),
    invoice: await upsertStage(salesPipeline.id, { externalId: externalId('stage-sales-invoice'), name: 'Счёт отправлен', position: 40, color: '#7c3aed', isWon: false, isLost: false, isVisible: true, raw: { demo: true } }),
    won: await upsertStage(salesPipeline.id, { externalId: externalId('stage-sales-won'), name: 'Успешно реализовано', position: 100, color: '#0f9f6e', isWon: true, isLost: false, isVisible: true, raw: { demo: true } }),
    lost: await upsertStage(salesPipeline.id, { externalId: externalId('stage-sales-lost'), name: 'Закрыто и не реализовано', position: 110, color: '#df3f3f', isWon: false, isLost: true, isVisible: true, raw: { demo: true } }),
  };
  const csmStages = {
    work: await upsertStage(csmPipeline.id, { externalId: externalId('stage-csm-work'), name: 'В работе', position: 10, color: '#2563eb', isWon: false, isLost: false, isVisible: true, raw: { demo: true } }),
    proposal: await upsertStage(csmPipeline.id, { externalId: externalId('stage-csm-proposal'), name: 'КП повторное', position: 20, color: '#d88a13', isWon: false, isLost: false, isVisible: true, raw: { demo: true } }),
  };

  const dealInputs = [
    { key: 'north-servers', title: 'ООО Север - серверы', amount: '1200000', pipeline: salesPipeline, stage: salesStages.proposal, responsible: anna, movedDaysAgo: 2, updatedDaysAgo: 1 },
    { key: 'techpark-invoice', title: 'ТехноПарк - счёт', amount: '2400000', pipeline: salesPipeline, stage: salesStages.invoice, responsible: boris, movedDaysAgo: 12, updatedDaysAgo: 10 },
    { key: 'logistics-offer', title: 'Логистика Плюс - КП', amount: '980000', pipeline: salesPipeline, stage: salesStages.proposal, responsible: boris, movedDaysAgo: 16, updatedDaysAgo: 8 },
    { key: 'medservice-first', title: 'МедСервис - первичный контакт', amount: '430000', pipeline: salesPipeline, stage: salesStages.qualify, responsible: anna, movedDaysAgo: 1, updatedDaysAgo: 1 },
    { key: 'csm-base', title: 'База - продление сервиса', amount: '760000', pipeline: csmPipeline, stage: csmStages.work, responsible: vera, movedDaysAgo: 9, updatedDaysAgo: 7 },
    { key: 'optima-repeat', title: 'Оптима - повторная поставка', amount: '610000', pipeline: salesPipeline, stage: salesStages.invoice, responsible: gleb, movedDaysAgo: 4, updatedDaysAgo: 1 },
    { key: 'unassigned-lead', title: 'Входящий лид без ответственного', amount: '350000', pipeline: salesPipeline, stage: salesStages.newLead, responsible: null, movedDaysAgo: 3, updatedDaysAgo: 2 },
  ];

  const deals = {};
  for (const input of dealInputs) {
    const deal = await prisma.deal.create({
      data: {
        externalId: externalId(`deal-${input.key}`),
        title: input.title,
        amount: input.amount,
        currency: 'RUB',
        pipelineId: input.pipeline.id,
        stageId: input.stage.id,
        responsibleId: input.responsible?.id ?? null,
        createdAt: daysAgo(input.movedDaysAgo + 5, 10),
        updatedAt: daysAgo(input.updatedDaysAgo, 15),
        raw: { demo: true },
      },
    });
    await prisma.dealStageHistory.create({
      data: {
        dealId: deal.id,
        toStageId: input.stage.id,
        movedAt: daysAgo(input.movedDaysAgo, 11),
        source: 'demo',
        raw: { demo: true },
      },
    });
    deals[input.key] = deal;
  }

  await prisma.task.createMany({
    data: [
      { externalId: externalId('task-north-call'), dealId: deals['north-servers'].id, responsibleId: anna.id, title: 'Позвонить по КП', typeName: 'Звонок', dueAt: hoursFromNow(3), isCompleted: false, raw: { demo: true } },
      { externalId: externalId('task-med-done'), dealId: deals['medservice-first'].id, responsibleId: anna.id, title: 'Уточнить потребность', typeName: 'Задача', dueAt: hoursFromNow(-2), completedAt: hoursFromNow(-1), isCompleted: true, raw: { demo: true } },
      { externalId: externalId('task-logistics-overdue'), dealId: deals['logistics-offer'].id, responsibleId: boris.id, title: 'Дожать ответ по КП', typeName: 'Звонок', dueAt: daysAgo(1, 13), isCompleted: false, raw: { demo: true } },
      { externalId: externalId('task-optima-future'), dealId: deals['optima-repeat'].id, responsibleId: gleb.id, title: 'Контроль оплаты', typeName: 'Задача', dueAt: hoursFromNow(30), isCompleted: false, raw: { demo: true } },
      { externalId: externalId('task-vera-overdue'), dealId: deals['csm-base'].id, responsibleId: vera.id, title: 'Согласовать продление', typeName: 'Задача', dueAt: daysAgo(2, 16), isCompleted: false, raw: { demo: true } },
    ],
  });

  await prisma.note.createMany({
    data: [
      { externalId: externalId('note-north'), dealId: deals['north-servers'].id, type: 'common', text: 'Клиент ждёт финальную спецификацию.', createdAt: daysAgo(1, 14), raw: { demo: true } },
      { externalId: externalId('note-logistics'), dealId: deals['logistics-offer'].id, type: 'common', text: 'КП отправлено, ответа нет.', createdAt: daysAgo(8, 10), raw: { demo: true } },
      { externalId: externalId('note-csm'), dealId: deals['csm-base'].id, type: 'common', text: 'Нужно согласовать условия продления.', createdAt: daysAgo(7, 12), raw: { demo: true } },
    ],
  });

  await prisma.emailThreadState.createMany({
    data: [
      {
        dealId: deals['logistics-offer'].id,
        threadId: externalId('thread-logistics'),
        lastIncomingNoteExternalId: externalId('mail-logistics-in'),
        lastIncomingAt: daysAgo(2, 11),
        lastOutgoingAt: null,
        lastMessageAt: daysAgo(2, 11),
        subject: 'Когда будет ответ по КП?',
        summary: 'Клиент просит обновить сроки поставки.',
        from: 'client@example.local',
        to: 'boris@example.local',
        isPending: true,
        messages: [{ direction: 'incoming', summary: 'Когда будет ответ по КП?' }],
      },
      {
        dealId: deals['csm-base'].id,
        threadId: externalId('thread-csm'),
        lastIncomingNoteExternalId: externalId('mail-csm-in'),
        lastIncomingAt: hoursFromNow(-5),
        lastOutgoingAt: null,
        lastMessageAt: hoursFromNow(-5),
        subject: 'Продление договора',
        summary: 'Клиент спрашивает условия продления.',
        from: 'customer@example.local',
        to: 'vera@example.local',
        isPending: true,
        messages: [{ direction: 'incoming', summary: 'Продление договора' }],
      },
    ],
  });

  const noTaskRule = await prisma.qualityRule.upsert({
    where: { code: externalId('rule-no-task') },
    create: {
      code: externalId('rule-no-task'),
      name: 'Нет касания по офферу сегодня',
      description: 'Демо-правило для локального Пульта РОПа.',
      severity: QualitySeverity.WARNING,
      enabled: true,
      config: { demo: true },
    },
    update: {
      name: 'Нет касания по офферу сегодня',
      severity: QualitySeverity.WARNING,
      enabled: true,
      config: { demo: true },
    },
  });
  const staleRule = await prisma.qualityRule.upsert({
    where: { code: externalId('rule-stale-stage') },
    create: {
      code: externalId('rule-stale-stage'),
      name: 'Сделка зависла на этапе',
      description: 'Демо-правило для локального Пульта РОПа.',
      severity: QualitySeverity.CRITICAL,
      enabled: true,
      config: { demo: true },
    },
    update: {
      name: 'Сделка зависла на этапе',
      severity: QualitySeverity.CRITICAL,
      enabled: true,
      config: { demo: true },
    },
  });

  await prisma.qualityViolation.createMany({
    data: [
      {
        ruleId: noTaskRule.id,
        managerId: boris.id,
        managerName: boris.name,
        groupId: salesGroup.id,
        groupName: salesGroup.name,
        dealId: deals['techpark-invoice'].id,
        severity: QualitySeverity.WARNING,
        message: 'Нет активной задачи по крупной сделке.',
        detectedAt: daysAgo(1, 17),
        payload: { demo: true },
      },
      {
        ruleId: staleRule.id,
        managerId: boris.id,
        managerName: boris.name,
        groupId: salesGroup.id,
        groupName: salesGroup.name,
        dealId: deals['logistics-offer'].id,
        severity: QualitySeverity.CRITICAL,
        message: 'Сделка стоит на этапе КП больше двух недель.',
        detectedAt: daysAgo(2, 9),
        payload: { demo: true },
      },
      {
        ruleId: staleRule.id,
        managerId: vera.id,
        managerName: vera.name,
        groupId: csmGroup.id,
        groupName: csmGroup.name,
        dealId: deals['csm-base'].id,
        severity: QualitySeverity.WARNING,
        message: 'Клиент ждёт ответ по продлению.',
        detectedAt: hoursFromNow(-5),
        payload: { demo: true },
      },
    ],
  });

  console.log(`ROP demo seed completed. Login: ${adminEmail} / ${adminPassword}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
