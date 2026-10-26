import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { DataQualityService } from '../quality/data-quality.service';
import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesService } from './workspaces.service';
import { performancePeriod, rankPerformance } from './performance-period';
import { goalMetricsFor, isMoneyMetric, roundMoney } from './rivile-sales';
import { RivileSalesService } from './rivile-sales.service';

const metrics = ['proposals', 'invoices', 'paid', 'shipments'] as const;
type Activity = { metric: string; dealId: string; actorId: string | null; occurredAt: Date; eventId: string; system?: boolean };

@Injectable()
export class PerformanceService {
    constructor(private readonly prisma: PrismaService, private readonly access: WorkspaceAccessService,
        private readonly reports: ReportsService, private readonly quality: DataQualityService, private readonly workspaces: WorkspacesService, private readonly rivile?: RivileSalesService) {}

    private async context(userId: string, query: Record<string, string>) {
        const scope = await this.access.resolve(userId);
        const department = await this.access.department(scope, query.department);
        const ids = await this.access.managerIds(scope, department, query.manager);
        return { scope, department, ids };
    }

    async overview(userId: string, query: Record<string, string>) {
        const { scope, department, ids } = await this.context(userId, query);
        return this.calculate(department, ids, query, scope.role !== 'MANAGER');
    }

    // Only the three event fields needed for the counters are read. Client data never enters this response.
    private async calculate(department: { key: string; name: string; groupId: string; assemblyPipelineId: string; shippingStageId: string }, ids: string[], query: Record<string, string>, canEdit: boolean) {
        const period = performancePeriod(query);
        const goalMetrics = goalMetricsFor(department.key);
        const availableMetrics = department.key === 'sales' ? [...metrics, 'shipmentMargin'] : [...metrics];
        const finance = department.key === 'sales' && this.rivile ? await this.rivile.read(period.month, period.start, period.end, department.key) : null;
        const definition = await this.reports.getTeamFunnelDefinition(department.key as 'sales' | 'csm');
        const contract = definition?.config.contract?.metrics || [];
        const metricIds = { proposals: department.key === 'sales' ? 'kp_presented' : 'offer_made', invoices: 'invoice_sent', paid: 'paid' };
        const stages = Object.entries(metricIds).flatMap(([metric, id]) => {
            const rule = contract.find(item => item.id === id);
            if (!rule?.stageIds?.length) throw new BadRequestException('Не настроены этапы показателя; нулевой результат не подставляется');
            return [...new Set(rule.stageIds)].map(stageId => ({ metric, stageId }));
        });
        const qualityBefore = await this.quality.status();
        const snapshot = await this.prisma.$transaction(async tx => {
            const [policy, names, goals, shipmentPlans, activities, shipments, unresolved] = await Promise.all([
                tx.workspaceCompetitionPeriod.findUnique({ where: { departmentKey_month: { departmentKey: department.key, month: period.month } } }),
                tx.crmUser.findMany({ where: { OR: [{ id: { in: ids } }, { groupId: department.groupId }] }, select: { id: true, name: true, isActive: true, groupId: true }, orderBy: { name: 'asc' } }),
                tx.workspaceKpiGoal.findMany({ where: { departmentKey: department.key, period: period.period, start: period.key } }),
                period.period === 'MONTH' ? tx.workspacePlan.findMany({ where: { departmentKey: department.key, month: period.month, metric: 'shipments' } }) : [],
                tx.$queryRaw<Activity[]>(Prisma.sql`
                    WITH rules(metric, stage_id) AS (VALUES ${Prisma.join(stages.map(s => Prisma.sql`(${s.metric}::text, ${s.stageId}::text)`))})
                    SELECT rules.metric, event."dealId" AS "dealId", actor."id" AS "actorId",
                           event."createdAt" AS "occurredAt", event."externalId" AS "eventId", (event."raw"->>'created_by' = '0') AS system
                    FROM "CrmEvent" event
                    JOIN fact_deal_current fact ON fact.deal_id = event."dealId"
                    JOIN rules ON TRUE
                    JOIN "PipelineStage" stage ON stage."id" = rules.stage_id
                    JOIN "Pipeline" pipeline ON pipeline."id" = stage."pipelineId"
                    LEFT JOIN "CrmUser" actor ON actor."externalId" = event."raw"->>'created_by'
                    WHERE event."type" = 'lead_status_changed' AND event."dealId" IS NOT NULL
                      AND (rules.metric <> 'paid' OR ${department.key} <> 'sales' OR event."raw"->>'created_by' <> '0')
                      AND event."createdAt" >= ${period.monthStart} AND event."createdAt" < ${period.monthEnd}
                      AND COALESCE(event."valueAfter"->0->'lead_status'->>'id', event."valueAfter"->0->'status'->>'id', event."valueAfter"->'lead_status'->>'id', event."valueAfter"->'status'->>'id', event."valueAfter"->>'id') = stage."externalId"
                      AND COALESCE(event."valueAfter"->0->'lead_status'->>'pipeline_id', event."valueAfter"->0->'status'->>'pipeline_id', event."valueAfter"->'lead_status'->>'pipeline_id', event."valueAfter"->'status'->>'pipeline_id', event."valueAfter"->>'pipeline_id') = pipeline."externalId"
                    ORDER BY event."createdAt", event."externalId"
                `),
                tx.$queryRaw<Array<{ dealId: string; actorId: string | null; amount: Prisma.Decimal; occurredAt: Date }>>(Prisma.sql`
                    SELECT fact.deal_id AS "dealId", link."managerId" AS "actorId", fact.amount,
                           MIN(transition.moved_at) AS "occurredAt"
                    FROM fact_deal_current fact
                    JOIN fact_stage_transition transition ON transition.deal_id = fact.deal_id AND transition.to_stage_id = ${department.shippingStageId}
                    JOIN "CommercialShipmentLink" link ON link."shipmentDealId" = fact.deal_id
                        AND link.status = 'CONFIRMED' AND link."departmentKey" = ${department.key}
                    WHERE fact.pipeline_id = ${department.assemblyPipelineId} AND fact.deleted_at IS NULL
                      AND transition.moved_at >= ${period.start} AND transition.moved_at < ${period.end}
                    GROUP BY fact.deal_id, link."managerId", fact.amount
                `),
                tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
                    SELECT COUNT(*) AS count FROM fact_deal_current fact
                    WHERE fact.pipeline_id = ${department.assemblyPipelineId} AND fact.deleted_at IS NULL
                      AND EXISTS (SELECT 1 FROM fact_stage_transition t WHERE t.deal_id = fact.deal_id AND t.to_stage_id = ${department.shippingStageId} AND t.moved_at >= ${period.start} AND t.moved_at < ${period.end})
                      AND NOT EXISTS (SELECT 1 FROM "CommercialShipmentLink" link WHERE link."shipmentDealId" = fact.deal_id AND link.status = 'CONFIRMED' AND link."managerId" IS NOT NULL AND link."departmentKey" IS NOT NULL)
                `),
            ]);
            const previous = (policy?.mode === 'UNIQUE_DEAL' || department.key === 'sales') && activities.length ? await tx.$queryRaw<Array<{ metric: string; dealId: string }>>(Prisma.sql`
                WITH rules(metric, stage_id) AS (VALUES ${Prisma.join(stages.map(s => Prisma.sql`(${s.metric}::text, ${s.stageId}::text)`))})
                SELECT DISTINCT rules.metric, event."dealId" AS "dealId"
                FROM "CrmEvent" event JOIN rules ON TRUE
                JOIN "PipelineStage" stage ON stage."id" = rules.stage_id
                JOIN "Pipeline" pipeline ON pipeline."id" = stage."pipelineId"
                WHERE event."type" = 'lead_status_changed' AND event."createdAt" < ${period.monthStart}
                  AND event."raw"->>'created_by' <> '0'
                  AND event."dealId" IN (${Prisma.join([...new Set(activities.map(e => e.dealId))])})
                  AND COALESCE(event."valueAfter"->0->'lead_status'->>'id', event."valueAfter"->0->'status'->>'id', event."valueAfter"->'lead_status'->>'id', event."valueAfter"->'status'->>'id', event."valueAfter"->>'id') = stage."externalId"
                  AND COALESCE(event."valueAfter"->0->'lead_status'->>'pipeline_id', event."valueAfter"->0->'status'->>'pipeline_id', event."valueAfter"->'lead_status'->>'pipeline_id', event."valueAfter"->'status'->>'pipeline_id', event."valueAfter"->>'pipeline_id') = pipeline."externalId"
            `) : [];
            if (canEdit && !query.manager) {
                const missing = [...new Set(activities.map(e => e.actorId).filter((id): id is string => Boolean(id && !names.some(n => n.id === id))))];
                if (missing.length) names.push(...await tx.crmUser.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, isActive: true, groupId: true } }));
            }
            return { policy, names, goals, shipmentPlans, activities, shipments, previous, unresolved: Number(unresolved[0]?.count || 0) };
        }, { isolationLevel: 'RepeatableRead', timeout: 20000 });
        const qualityAfter = await this.quality.status();
        const certified = qualityBefore.overall === 'CERTIFIED' && qualityAfter.overall === 'CERTIFIED';
        const fresh = certified && Boolean(qualityBefore.cutoffAt && Date.now() - +new Date(qualityBefore.cutoffAt) < 180000);
        const selectedIds = new Set(ids), nameIds = new Set(snapshot.names.filter(n => n.groupId === department.groupId).map(n => n.id));
        if (canEdit && !query.manager) for (const event of snapshot.activities) if (event.actorId) selectedIds.add(event.actorId);
        if (finance && canEdit && !query.manager) {
            for (const link of finance.links) if (link.crmUserId) selectedIds.add(link.crmUserId);
            const missing = [...selectedIds].filter(id => !snapshot.names.some(n => n.id === id));
            if (missing.length) snapshot.names.push(...await this.prisma.crmUser.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, isActive: true, groupId: true } }));
        }
        const seen = new Set<string>(snapshot.previous.map(e => `${e.metric}:${e.dealId}`));
        const credited = snapshot.activities.filter(event => {
            const unique = snapshot.policy?.mode === 'UNIQUE_DEAL' || department.key === 'sales' && event.metric === 'paid';
            if (unique && event.system) return false;
            const key = `${event.metric}:${event.dealId}`;
            if (unique) { if (seen.has(key)) return false; seen.add(key); }
            return event.occurredAt >= period.start && event.occurredAt < period.end;
        });
        const valuesFor = (id: string | null) => availableMetrics.map(metric => {
            const relevant = (actor: string | null) => Boolean(actor && (id ? actor === id : selectedIds.has(actor)));
            const fact = metric === 'shipmentMargin' ? finance?.source.cutoffAt ? roundMoney(finance.documents.filter(d => relevant(d.managerId)).reduce((s, d) => s + d.margin, 0)) : null
                : metric === 'shipments' ? snapshot.shipments.filter(e => relevant(e.actorId)).reduce((s, e) => s + Number(e.amount), 0)
                : credited.filter(e => e.metric === metric && relevant(e.actorId)).length;
            const raw = isMoneyMetric(metric) ? fact : snapshot.activities.filter(e => e.metric === metric && e.occurredAt >= period.start && e.occurredAt < period.end && (!id && !query.manager ? true : relevant(e.actorId))).length;
            const goal = (metric === 'shipments' && period.period === 'MONTH' ? snapshot.shipmentPlans : snapshot.goals).find(g => g.metric === metric && g.targetType === (id ? 'MANAGER' : 'GROUP') && g.targetId === (id || department.groupId));
            const plan = goalMetrics.includes(metric) && goal ? Number(goal.value) : null;
            const trustworthy = metric !== 'shipmentMargin' || finance?.source.status === 'CERTIFIED';
            return { metric, fact, raw, plan, version: goal?.version || 0, completion: trustworthy && fact != null && plan != null && plan > 0 ? fact / plan * 100 : null, remaining: trustworthy && fact != null && plan != null ? Math.max(0, plan - fact) : null, unit: isMoneyMetric(metric) ? 'EUR' : 'count' };
        });
        const rows = snapshot.names.filter(n => selectedIds.has(n.id)).map(n => ({ id: n.id, name: n.name, active: n.isActive, currentMember: n.isActive && n.groupId === department.groupId, canSetGoal: ids.includes(n.id), participant: snapshot.policy?.memberIds.includes(n.id) || false, values: valuesFor(n.id) }));
        const unattributedMetrics = [...new Set(credited.filter(e => !e.actorId && !e.system).map(e => e.metric))];
        const unknownEvents = snapshot.activities.filter(e => !e.actorId || !nameIds.has(e.actorId)).filter(e => e.occurredAt >= period.start && e.occurredAt < period.end).length;
        let proof: { total: number; page: number; rows: any[] } | null = null;
        if (query.detail === 'shipmentMargin' && finance) {
            const page = Math.max(1, Math.min(10000, Math.floor(Number(query.page) || 1)));
            const documents = finance.documents.filter(d => selectedIds.has(d.managerId)).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
            proof = { total: documents.length, page, rows: documents.slice((page - 1) * 50, page * 50).map(d => ({ eventId: d.id, occurredAt: `${d.date}T00:00:00+03:00`, counted: true, externalId: null, title: `Документ Ривиле ${d.number}`, reason: `Выручка ${d.revenue.toFixed(2)} € − себестоимость ${d.cost.toFixed(2)} € = маржа ${d.margin.toFixed(2)} €. ${d.operation === '52' ? 'Возврат уменьшает результат.' : 'Проведённая продажа.'}` })) };
        }
        if (metrics.includes(query.detail as any)) {
            const page = Math.max(1, Math.floor(Number(query.page) || 1));
            const creditedIds = new Set(credited.map(e => e.eventId));
            const events = query.detail === 'shipments' ? snapshot.shipments.filter(e => e.actorId && selectedIds.has(e.actorId)).map(e => ({ ...e, eventId: null, counted: true, reason: 'Уникальная сборка, продавец подтверждён' }))
                : snapshot.activities.filter(e => e.metric === query.detail && e.actorId && selectedIds.has(e.actorId) && e.occurredAt >= period.start && e.occurredAt < period.end).map(e => ({ ...e, counted: creditedIds.has(e.eventId), reason: creditedIds.has(e.eventId) ? 'Зачтено' : 'Повторный переход по той же сделке, включая прошлые месяцы' }));
            const selected = events.slice((page - 1) * 50, page * 50);
            const facts = await this.prisma.factDealCurrent.findMany({ where: { dealId: { in: selected.map(e => e.dealId) } }, select: { dealId: true, dealExternalId: true, title: true, responsibleId: true, pipelineId: true } });
            const pipelines = definition?.pipelineIds || [];
            proof = { total: events.length, page, rows: selected.map(e => {
                const fact = facts.find(d => d.dealId === e.dealId);
                const visible = Boolean(fact && (query.detail === 'shipments' ? fact.pipelineId === department.assemblyPipelineId : pipelines.includes(fact.pipelineId) && (canEdit || fact.responsibleId === e.actorId)));
                return { eventId: e.eventId, occurredAt: e.occurredAt, counted: e.counted, reason: e.reason, title: visible ? fact!.title : 'Историческое действие по переданной сделке', externalId: visible ? fact!.dealExternalId : null };
            }) };
        }
        return { period: period.period, start: period.key, end: new Date(+period.end - 1).toISOString(), month: period.month, department: department.name,
            goalMetrics, marginSource: department.key === 'sales' ? finance?.source || { status: 'CHECKING', reason: 'Ривиле не настроена', cutoffAt: null } : null,
            unknownRivileCodes: canEdit ? finance?.unknownCodes : undefined,
            canEdit, policy: snapshot.policy ? { mode: snapshot.policy.mode, createdAt: snapshot.policy.createdAt, memberIds: canEdit ? snapshot.policy.memberIds : undefined } : null,
            rows, proof, total: canEdit && !query.manager ? { id: department.groupId, name: department.name, values: valuesFor(null) } : null,
            incompleteShipments: snapshot.unresolved > 0, unresolvedShipments: canEdit ? snapshot.unresolved : undefined, unattributedMetrics,
            unknownEvents: canEdit ? unknownEvents : undefined,
            dataStatus: { status: fresh ? 'CERTIFIED' : qualityAfter.overall === 'BLOCKED' ? 'BLOCKED' : 'CHECKING', cutoffAt: qualityBefore.cutoffAt, checkedAt: qualityBefore.checkedAt },
            definition: snapshot.policy?.mode === 'UNIQUE_DEAL' ? 'Один зачёт на сделку и показатель — первому исполнителю по загруженной истории amoCRM. Автоматизация не участвует. Повторные переходы, в том числе в другом месяце, не дают нового зачёта.' : 'Переходы этапов amoCRM по исполнителю действия, включая повторные. Это не количество уникальных сделок.',
            shipmentDefinition: 'Уникальные сборки, перешедшие в отгрузку за период; текущая сумма в EUR, подтверждённый коммерческий продавец. Не банковский реестр.',
            periodNote: period.period === 'WEEK' ? 'Понедельник–воскресенье в пределах выбранного месяца; неполная неделя имеет отдельную цель.' : 'Календарный период, московское время.',
        };
    }

    async saveGoal(userId: string, body: Record<string, any>) {
        const { scope, department } = await this.context(userId, { department: body.department, ...(body.targetType === 'MANAGER' ? { manager: body.targetId } : {}) });
        if (scope.role === 'MANAGER') throw new ForbiddenException('Цели задаёт РОП или администратор');
        const period = performancePeriod(body);
        if (!goalMetricsFor(department.key).includes(body.metric) || !['GROUP', 'MANAGER'].includes(body.targetType) || (body.targetType === 'GROUP' && body.targetId !== department.groupId)) throw new BadRequestException('Некорректная цель: у продаж план только по марже Ривиле и количеству оплат');
        if (department.key === 'sales' && period.period !== 'MONTH') throw new BadRequestException('У продаж согласованы месячные цели');
        const value = Number(body.value);
        if (body.value == null || body.value === '' || !Number.isFinite(value) || value < 0 || value > 1e12 || (!isMoneyMetric(body.metric) && !Number.isInteger(value))) throw new BadRequestException('Укажите неотрицательную цель; количество должно быть целым');
        if (body.metric === 'shipments' && period.period === 'MONTH') return this.workspaces.savePlan(userId, { ...body, month: period.month });
        const where = { departmentKey: department.key, period: period.period, start: period.key, targetType: String(body.targetType), targetId: String(body.targetId), metric: String(body.metric) };
        return this.prisma.$transaction(async tx => {
            const old = await tx.workspaceKpiGoal.findUnique({ where: { departmentKey_period_start_targetType_targetId_metric: where } });
            if ((old?.version || 0) !== Number(body.version)) throw new ConflictException('Цель уже изменена. Обновите данные');
            const goal = old ? await tx.workspaceKpiGoal.update({ where: { id: old.id, version: old.version }, data: { value, version: { increment: 1 } } }) : await tx.workspaceKpiGoal.create({ data: { ...where, value } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.kpi-goal.updated', entity: 'WorkspaceKpiGoal', entityId: goal.id, metadata: { ...where, before: old ? String(old.value) : null, after: String(goal.value) } } });
            return { version: goal.version };
        }).catch(e => { if (['P2002', 'P2025', 'P2034'].includes(e?.code)) throw new ConflictException('Цель уже изменена. Обновите данные'); throw e; });
    }

    async competitionSettings(userId: string, query: Record<string, string>) {
        const { scope, department } = await this.context(userId, query);
        if (scope.role === 'MANAGER') throw new ForbiddenException('Настройка соревнования недоступна');
        const { month } = performancePeriod(query);
        const [policy, users, heads] = await Promise.all([
            this.prisma.workspaceCompetitionPeriod.findUnique({ where: { departmentKey_month: { departmentKey: department.key, month } } }),
            this.prisma.crmUser.findMany({ where: { groupId: department.groupId, isActive: true, isVisible: true }, select: { id: true, name: true, email: true, raw: true }, orderBy: { name: 'asc' } }),
            this.prisma.user.findMany({ where: { isActive: true, businessRole: { in: ['ROP', 'OWNER'] }, crmUserId: { not: null } }, select: { crmUserId: true } }),
        ]);
        return { policy, candidates: users.filter(u => u.email && !((u.raw as any)?.rights || (u.raw as any)?.permissions)?.is_admin && !heads.some(h => h.crmUserId === u.id)).map(u => ({ id: u.id, name: u.name })) };
    }

    async setCompetition(userId: string, body: Record<string, any>) {
        const { department } = await this.context(userId, { department: body.department });
        if (department.key === 'sales' && body.mode !== 'UNIQUE_DEAL') throw new BadRequestException('Для продаж согласован один зачёт на сделку');
        const settings = await this.competitionSettings(userId, body);
        if (!['UNIQUE_DEAL', 'AMO_EVENTS'].includes(body.mode) || body.confirmed !== true || !Array.isArray(body.memberIds) || !body.memberIds.length) throw new BadRequestException('Подтвердите правила и выберите участников');
        const memberIds = [...new Set(body.memberIds)] as string[];
        if (memberIds.some(id => !settings.candidates.some(c => c.id === id))) throw new BadRequestException('Участник не входит в список действующих менеджеров отдела');
        const period = performancePeriod(body);
        if (period.month < performancePeriod({}).month) throw new BadRequestException('Закрытый месяц нельзя запускать задним числом');
        return this.prisma.$transaction(async tx => {
            if (await tx.workspaceCompetitionPeriod.findUnique({ where: { departmentKey_month: { departmentKey: department.key, month: period.month } } })) throw new ConflictException('Правила и состав на этот месяц уже утверждены и не меняются');
            const policy = await tx.workspaceCompetitionPeriod.create({ data: { departmentKey: department.key, month: period.month, mode: body.mode, memberIds, createdBy: userId } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.competition.started', entity: 'WorkspaceCompetitionPeriod', entityId: policy.id, metadata: { month: period.month, mode: policy.mode, memberIds } } });
            return { ok: true };
        }).catch(e => { if (e?.code === 'P2002') throw new ConflictException('Правила уже утверждены'); throw e; });
    }

    private async admin(userId: string) { if ((await this.access.resolve(userId)).role !== 'ADMIN') throw new ForbiddenException('Только администратор управляет экранами'); }
    async rivileRefresh(userId: string, body: Record<string, string>) {
        const { scope } = await this.context(userId, { department: 'sales' });
        if (scope.role === 'MANAGER') throw new ForbiddenException('Обновление запрашивает РОП или администратор');
        const { month } = performancePeriod(body);
        if (month > performancePeriod({}).month) throw new BadRequestException('Будущий месяц недоступен');
        return this.rivile!.request(month);
    }
    async rivileSettings(userId: string) {
        await this.admin(userId);
        return { profiles: await this.prisma.salesTargetProfile.findMany(), links: await this.prisma.rivileManagerLink.findMany({ orderBy: { code: 'asc' } }), users: await this.prisma.crmUser.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }), departments: await this.prisma.workspaceDepartment.findMany({ select: { key: true, name: true } }) };
    }
    async salesTargetProfile(userId: string, body: Record<string, any>) {
        await this.admin(userId);
        const marginTarget = Number(body.marginTarget), paidTarget = Number(body.paidTarget);
        if (typeof body.crmUserId !== 'string' || !body.crmUserId || body.marginTarget == null || body.marginTarget === '' || body.paidTarget == null || body.paidTarget === '' || !Number.isFinite(marginTarget) || marginTarget < 0 || marginTarget > 1e12 || !Number.isInteger(paidTarget) || paidTarget < 0 || paidTarget > 100000) throw new BadRequestException('Укажите корректные цели в EUR и целое количество сделок');
        const department = await this.prisma.workspaceDepartment.findUniqueOrThrow({ where: { key: 'sales' } });
        const user = await this.prisma.crmUser.findFirst({ where: { id: body.crmUserId, groupId: department.groupId, isActive: true, isVisible: true }, select: { id: true } });
        if (!user) throw new BadRequestException('Выберите действующего менеджера продаж');
        return this.prisma.$transaction(async tx => {
            const old = await tx.salesTargetProfile.findUnique({ where: { crmUserId: user.id } });
            if ((old?.version || 0) !== Number(body.version)) throw new ConflictException('Шаблон уже изменён');
            const profile = await tx.salesTargetProfile.upsert({ where: { crmUserId: user.id }, create: { crmUserId: user.id, marginTarget, paidTarget }, update: { marginTarget, paidTarget, version: { increment: 1 } } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.sales-target.profile-updated', entity: 'SalesTargetProfile', entityId: user.id, metadata: { before: old, after: profile } as any } });
            return { ok: true };
        }, { isolationLevel: 'Serializable' }).catch(e => { if (['P2002','P2025','P2034'].includes(e?.code)) throw new ConflictException('Настройки уже изменены. Обновите страницу'); throw e; });
    }

    async rivileMapping(userId: string, body: Record<string, any>) {
        await this.admin(userId);
        if (typeof body.code !== 'string' || (!body.code.trim() || body.code !== body.code.trim() || body.code.length > 40 || /[\u0000-\u001f\u007f]/.test(body.code)) || body.confirmed !== true || (body.crmUserId != null && typeof body.crmUserId !== 'string') || (body.departmentKey !== 'outside' && (typeof body.crmUserId !== 'string' || !body.crmUserId)) || !['sales', 'csm', 'outside'].includes(body.departmentKey)) throw new BadRequestException('Подтвердите код Ривиле, сотрудника и отдел');
        const user = body.crmUserId ? await this.prisma.crmUser.findUnique({ where: { id: body.crmUserId }, select: { id: true } }) : null;
        if (body.departmentKey !== 'outside' && !user) throw new BadRequestException('Сотрудник amoCRM не найден');
        return this.prisma.$transaction(async tx => {
            const old = await tx.rivileManagerLink.findUnique({ where: { code: body.code } });
            if ((old?.updatedAt.toISOString() || '') !== (body.version || '')) throw new ConflictException('Связь уже изменена; обновите настройки');
            const data = { crmUserId: user?.id || null, departmentKey: body.departmentKey === 'outside' ? null : body.departmentKey, source: 'OWNER_CONFIRMED_UI' };
            const link = await tx.rivileManagerLink.upsert({ where: { code: body.code }, create: { code: body.code, ...data }, update: data });
            await tx.auditLog.create({ data: { userId, action: 'workspace.rivile.mapping.updated', entity: 'RivileManagerLink', entityId: link.code, metadata: { before: old, after: link } as any } });
            return { ok: true };
        }, { isolationLevel: 'Serializable' }).catch(e => { if (['P2002','P2025','P2034'].includes(e?.code)) throw new ConflictException('Настройки уже изменены. Обновите страницу'); throw e; });
    }
    async displays(userId: string) {
        await this.admin(userId);
        return this.prisma.workspaceDisplay.findMany({ select: { id: true, name: true, departmentKey: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    }
    async createDisplay(userId: string, body: Record<string, any>) {
        await this.admin(userId);
        const department = await this.access.department(await this.access.resolve(userId), body.department);
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || ![8, 24, 168].includes(Number(body.hours))) throw new BadRequestException('Укажите название экрана и срок доступа');
        const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + Number(body.hours) * 3600000);
        const display = await this.prisma.$transaction(async tx => {
            const row = await tx.workspaceDisplay.create({ data: { name: body.name.trim(), departmentKey: department.key, createdBy: userId, tokenHash: this.hash(token), expiresAt } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.display.created', entity: 'WorkspaceDisplay', entityId: row.id, metadata: { department: department.key, expiresAt: expiresAt.toISOString() } } });
            return row;
        });
        return { id: display.id, token, expiresAt };
    }
    async revokeDisplay(userId: string, id: string) {
        await this.admin(userId);
        await this.prisma.$transaction(async tx => {
            const row = await tx.workspaceDisplay.findUnique({ where: { id } });
            if (!row) throw new BadRequestException('Экран не найден');
            await tx.workspaceDisplay.update({ where: { id }, data: { revokedAt: new Date() } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.display.revoked', entity: 'WorkspaceDisplay', entityId: id } });
        });
        return { ok: true };
    }
    private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
    async displayPreview(userId: string, query: Record<string, string>) {
        await this.admin(userId);
        const { department, ids } = await this.context(userId, query);
        return this.displayResponse(department.key, await this.calculate(department, ids, { period: 'MONTH' }, false), query);
    }
    async display(token: string, query: Record<string, string>) {
        if (!token || token.length > 100) throw new UnauthorizedException('Доступ экрана не настроен');
        const display = await this.prisma.workspaceDisplay.findUnique({ where: { tokenHash: this.hash(token) } });
        if (!display || display.revokedAt || display.expiresAt < new Date()) throw new UnauthorizedException('Доступ экрана истёк или отозван');
        const department = await this.prisma.workspaceDepartment.findUnique({ where: { key: display.departmentKey } });
        if (!department) throw new UnauthorizedException('Отдел экрана недоступен');
        const ids = (await this.prisma.crmUser.findMany({ where: { groupId: department.groupId, isActive: true }, select: { id: true } })).map(u => u.id);
        const result = await this.calculate(department, ids, { period: 'MONTH' }, false);
        return this.displayResponse(department.key, result, query);
    }
    private displayResponse(departmentKey: string, result: Awaited<ReturnType<PerformanceService['calculate']>>, query: Record<string, string>) {
        // Explicit allowlist: no CRM IDs, source links, admin data, customer names, or financial costs.
        return { department: result.department, departmentKey, month: result.month, by: query.by === 'fact' ? 'fact' : 'completion',
            dataStatus: result.dataStatus, definition: result.definition,
            boards: (departmentKey === 'sales' ? ['shipmentMargin', 'paid', 'proposals', 'invoices', 'shipments'] : [...metrics]).map(metric => ({ metric,
                by: !result.goalMetrics.includes(metric) || query.by === 'fact' ? 'fact' : 'completion',
                sourceCutoffAt: metric === 'shipmentMargin' ? result.marginSource?.cutoffAt : result.dataStatus.cutoffAt,
                paused: result.dataStatus.status !== 'CERTIFIED' || !result.policy || (metric === 'shipmentMargin' && result.marginSource?.status !== 'CERTIFIED') || (metric === 'shipments' && result.incompleteShipments) || result.unattributedMetrics.includes(metric),
                reason: !result.policy ? 'Правила и участники не утверждены' : metric === 'shipmentMargin' && result.marginSource?.status !== 'CERTIFIED' ? result.marginSource?.reason : metric === 'shipments' && result.incompleteShipments ? 'Есть отгрузки без подтверждённого продавца' : result.unattributedMetrics.includes(metric) ? 'Есть действия без подтверждённого исполнителя' : result.dataStatus.status !== 'CERTIFIED' ? 'Данные проходят проверку' : null,
                rows: rankPerformance(result.rows.filter(r => r.participant && r.active), metric, !result.goalMetrics.includes(metric) || query.by === 'fact' ? 'fact' : 'completion', metric === 'shipmentMargin' ? result.marginSource?.status !== 'CERTIFIED' : result.incompleteShipments).map(r => ({ name: r.name, rank: r.rank, ...r.values.find(v => v.metric === metric) })),
            })),
        };
    }
}
