import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { WorkspaceAccessService } from './workspace-access.service';
import { CommercialLinksService } from './commercial-links.service';
import * as bcrypt from 'bcryptjs';
import { DataQualityService } from '../quality/data-quality.service';
const currentMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date());
const metricKeys = ['payments', 'shipments'];
@Injectable()
export class WorkspacesService {
    constructor(private readonly prisma: PrismaService, private readonly access: WorkspaceAccessService, private readonly reports: ReportsService, private readonly links: CommercialLinksService, private readonly quality: DataQualityService) { }
    async session(userId: string) {
        const identity = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, role: true, businessRole: true, isActive: true } });
        if (!identity?.isActive)
            throw new ForbiddenException('Учётная запись отключена');
        try {
            const scope = await this.access.resolve(userId);
            const departments = await this.prisma.workspaceDepartment.findMany({ where: scope.role === 'ADMIN' ? {} : { key: scope.departmentKey! }, orderBy: { key: 'desc' } });
            const managers = await this.prisma.crmUser.findMany({ where: scope.managerId ? { id: scope.managerId }
                    : { groupId: { in: departments.map(d => d.groupId) } }, select: { id: true, name: true, groupId: true, isActive: true }, orderBy: { name: 'asc' } });
            const connection = await this.prisma.amoConnection.findFirst({ orderBy: { createdAt: 'desc' }, select: { subdomain: true, lastReconcileAt: true, lastWebhookAppliedAt: true, lastCertifiedAt: true, status: true } });
            const cutoff = connection ? [connection.lastReconcileAt, connection.lastWebhookAppliedAt].filter(Boolean).sort((a, b) => +b! - +a!)[0] : null;
            const quality = await this.quality.status();
            return { configured: departments.length > 0, name: identity.name, role: scope.role, departmentKey: scope.departmentKey,
                managerId: scope.managerId, fingerprint: scope.fingerprint, departments, managers,
                amoDomain: (connection?.subdomain||'').replace(/^https?:\/\//,'').replace(/\.amocrm\.ru\/?$/,''), cutoffAt: cutoff, checkedAt: connection?.lastCertifiedAt,
                fresh: Boolean(cutoff && Date.now() - +cutoff < 180000 && connection?.status !== 'ERROR' && quality.overall === 'CERTIFIED'),
                reports: { sales: ['sales_funnel_steps', 'sales_weighted_funnel', 'sales_assigned_stage_speed', 'sales_stage_age', 'sales_loss_reasons'],
                    csm: ['csm_funnel', 'csm_weighted_funnel', 'csm_base_stage_age', 'csm_assigned_stage_age'] } };
        }
        catch (error) {
            if (!(error instanceof ForbiddenException))
                throw error;
            return { configured: false, name: identity.name, message: error.message };
        }
    }
    private month(value?: string) {
        const month = value || currentMonth();
        if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))
            throw new BadRequestException('Некорректный месяц');
        const [year, number] = month.split('-').map(Number);
        return { key: month, start: new Date(`${month}-01T00:00:00+03:00`), end: new Date(Date.UTC(year, number, 1) - 3 * 3600000 - 1) };
    }
    private async context(userId: string, query: Record<string, string> = {}) {
        const scope = await this.access.resolve(userId);
        const department = await this.access.department(scope, query.department);
        const managers = await this.access.managerIds(scope, department, query.manager);
        return { scope: { ...scope, departmentKey: department.key }, department, managers, month: this.month(query.month) };
    }
    async report(userId: string, key: string, query: Record<string, string>) {
        if(query.department==='all')return this.reports.companyReport(key,await this.access.resolve(userId),this.month(query.month).key);
        const { scope, month,department } = await this.context(userId, query);
        if (key === 'revenue_profit_forecast' && month.key !== currentMonth())
            throw new BadRequestException('Прогноз доступен на текущий месяц');
        const report = await this.reports.workspaceReport(key, scope, month.key, query.manager);
        if(key==='revenue_profit_forecast')(report as any).incompleteShipments=await this.hasUnassignedShipments(department,month);
        // No calibration cohorts or individual colleague features in personal results.
        if (scope.role === 'MANAGER' && report?.type === 'revenueProfitForecast') {
            const { shippingCycle, deliveryCalibration, assemblyCohort, ...personal } = report as any;
            return personal;
        }
        return report;
    }
    async exportReport(userId: string, key: string, query: Record<string, string>) {
        if(query.department==='all')return this.reports.companyReport(key,await this.access.resolve(userId),this.month(query.month).key,true);
        const { scope, month } = await this.context(userId, query);
        return this.reports.enqueueWorkspaceExport(key, scope, month.key, query.manager);
    }
    async exportJob(userId: string, id: string, download = false) {
        await this.access.resolve(userId);
        return download ? this.reports.getExportFile(id, { id: userId, role: 'ROP' }) : this.reports.getExportJob(id, { id: userId, role: 'ROP' });
    }
    private async admin(userId: string) {
        const scope = await this.access.resolve(userId);
        if (scope.role !== 'ADMIN')
            throw new ForbiddenException('Настройки доступны только администратору');
    }
    async adminSettings(userId: string) {
        await this.admin(userId);
        const [users, crmUsers, departments, rules, stages, unresolved,commercialSellers] = await Promise.all([
            this.prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, businessRole: true, departmentKey: true, crmUserId: true, isActive: true, accessVersion: true } }),
            this.prisma.crmUser.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true, groupId: true }, orderBy: { name: 'asc' } }),
            this.prisma.workspaceDepartment.findMany(), this.prisma.ropStageSlaRule.findMany(),
            this.prisma.pipelineStage.findMany({ where: { isWon: false, isLost: false }, select: { id: true, name: true, pipelineId: true,pipeline:{select:{name:true}} }, orderBy: { position: 'asc' } }),
            this.prisma.commercialShipmentLink.count({ where: { status: { not: 'CONFIRMED' } } }),
            this.prisma.crmUser.findMany({select:{id:true,name:true,isActive:true},orderBy:{name:'asc'}}),
        ]);
        return { users, crmUsers, departments, rules, stages, unresolved,commercialSellers };
    }
    async updateAccount(userId: string, id: string, body: Record<string, any>) {
        await this.admin(userId);
        if (!['OWNER', 'ROP', 'MANAGER'].includes(body.businessRole))
            throw new BadRequestException('Неизвестная роль');
        if (body.businessRole !== 'OWNER') {
            const department = await this.prisma.workspaceDepartment.findUnique({ where: { key: String(body.departmentKey) } });
            if (!department)
                throw new BadRequestException('Выберите отдел');
        }
        if (body.businessRole === 'MANAGER' && !body.crmUserId)
            throw new BadRequestException('Укажите сотрудника amoCRM');
        if (body.crmUserId && !await this.prisma.crmUser.findUnique({ where: { id: String(body.crmUserId) } }))
            throw new BadRequestException('Сотрудник amoCRM не найден');
        if (id === userId && (body.isActive === false || body.businessRole !== 'OWNER'))
            throw new BadRequestException('Нельзя отключить собственный административный доступ');
        if (body.password && (!String(body.password).match(/^.{12,128}$/s)))
            throw new BadRequestException('Пароль должен содержать от 12 до 128 символов');
        const passwordHash = body.password ? await bcrypt.hash(String(body.password), 12) : undefined;
        return this.prisma.$transaction(async (tx) => {
            const old = await tx.user.findUnique({ where: { id }, select: { businessRole: true, departmentKey: true, crmUserId: true, isActive: true, accessVersion: true } });
            if (!old)
                throw new BadRequestException('Учётная запись не найдена');
            if (old.accessVersion !== Number(body.version))
                throw new ConflictException('Права уже изменены другим администратором. Обновите данные');
            const data = { businessRole: body.businessRole, role: body.businessRole === 'OWNER' ? 'ADMIN' : 'ROP', departmentKey: body.businessRole === 'OWNER' ? null : String(body.departmentKey), crmUserId: body.crmUserId ? String(body.crmUserId) : null, isActive: body.isActive !== false, accessVersion: { increment: 1 }, ...(passwordHash ? { passwordHash } : {}) };
            await tx.user.update({ where: { id }, data: data as any });
            await tx.auditLog.create({ data: { userId, action: 'workspace.access.updated', entity: 'User', entityId: id, metadata: { before: old, after: { businessRole: data.businessRole, departmentKey: data.departmentKey, crmUserId: data.crmUserId, isActive: data.isActive }, passwordChanged: Boolean(passwordHash) } } });
            return { ok: true };
        });
    }
    async createAccount(userId: string, body: Record<string, any>) {
        await this.admin(userId);
        const crm = await this.prisma.crmUser.findUnique({ where: { id: String(body.crmUserId) } });
        if (!crm?.isActive || !crm.email)
            throw new BadRequestException('Выберите активного сотрудника с email в amoCRM');
        if (!['ROP', 'MANAGER'].includes(body.businessRole) || !await this.prisma.workspaceDepartment.findUnique({ where: { key: String(body.departmentKey) } }))
            throw new BadRequestException('Укажите роль и отдел');
        if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128)
            throw new BadRequestException('Укажите личный пароль от 12 до 128 символов');
        const passwordHash = await bcrypt.hash(body.password, 12);
        return this.prisma.$transaction(async (tx) => {
            if (await tx.user.findFirst({ where: { OR: [{ email: crm.email!.toLowerCase() }, { crmUserId: crm.id }] } }))
                throw new ConflictException('Учётная запись этого сотрудника уже существует');
            const user = await tx.user.create({ data: { name: crm.name, email: crm.email!.toLowerCase(), passwordHash, crmUserId: crm.id, businessRole: body.businessRole, role: 'ROP', departmentKey: body.departmentKey } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.account.created', entity: 'User', entityId: user.id, metadata: { businessRole: user.businessRole, departmentKey: user.departmentKey, crmUserId: crm.id } } });
            return { id: user.id, name: user.name };
        });
    }
    async updateStageRule(userId: string, body: Record<string, any>) {
        await this.admin(userId);
        const dept = await this.prisma.workspaceDepartment.findUnique({ where: { key: String(body.departmentKey) } });
        const stage = await this.prisma.pipelineStage.findUnique({ where: { id: String(body.stageId) } });
        if (!dept || !stage || ![...dept.pipelineIds, dept.assemblyPipelineId].includes(stage.pipelineId))
            throw new BadRequestException('Этап не относится к отделу');
        const days = body.isEnabled === false ? null : Number(body.slaDays);
        if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650))
            throw new BadRequestException('Срок должен быть от 1 до 3650 календарных дней');
        return this.prisma.$transaction(async (tx) => {
            const where = { departmentKey_stageId: { departmentKey: dept.key, stageId: stage.id } };
            const old = await tx.ropStageSlaRule.findUnique({ where });
            const rule = await tx.ropStageSlaRule.upsert({ where, create: { departmentKey: dept.key, stageId: stage.id, isEnabled: days != null, slaDays: days, reason: 'Настроено администратором' }, update: { isEnabled: days != null, slaDays: days, reason: 'Настроено администратором' } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.stage-rule.updated', entity: 'RopStageSlaRule', entityId: rule.id, metadata: { before: old?.slaDays ?? null, after: days } } });
            return { ok: true };
        });
    }
    async plans(userId: string, query: Record<string, string>) {
        const { scope, department, managers, month } = await this.context(userId, query);
        const planRows = await this.prisma.workspacePlan.findMany({ where: { month: month.key, departmentKey: department.key,
                ...(scope.role === 'MANAGER' ? { targetType: 'MANAGER', targetId: scope.managerId! } : {}) } });
        const definition = await this.reports.getTeamFunnelDefinition(department.key as 'sales' | 'csm');
        const report = await this.reports.workspaceReport(department.key === 'sales' ? 'sales_funnel_steps' : 'csm_funnel', scope, month.key, query.manager);
        if (report?.type !== 'contract' || !report.summaryRows?.[0]?.metrics)
            throw new ServiceUnavailableException('Факт оплат недоступен; нулевой результат не подставляется');
        const paymentMetric = department.key === 'sales' ? 'payment_amount' : 'paid_amount';
        const assembly = await this.prisma.factDealCurrent.findMany({ where: { pipelineId: department.assemblyPipelineId, deletedAt: null,
                dealId: { in: (await this.prisma.commercialShipmentLink.findMany({ where: { status: 'CONFIRMED', departmentKey: department.key, managerId: { in: managers } }, select: { shipmentDealId: true } })).map(l => l.shipmentDealId) } }, select: { dealId: true, amount: true } });
        const transitions = assembly.length ? await this.prisma.factStageTransition.findMany({ where: { dealId: { in: assembly.map(d => d.dealId) }, toStageId: department.shippingStageId, movedAt: { gte: month.start, lte: month.end } }, orderBy: { movedAt: 'asc' }, select: { dealId: true, movedAt: true } }) : [];
        const shippedIds = new Set(transitions.map(t => t.dealId));
        const assignments = await this.links.assignment(assembly.map(d => d.dealId));
        const names = await this.prisma.crmUser.findMany({ where: { id: { in: managers } }, select: { id: true, name: true } });
        if (scope.role !== 'MANAGER' && !query.manager)
            for (const row of report.rows || [])
                if (!names.some(n => n.id === row.groupId))
                    names.push({ id: row.groupId, name: row.groupName });
        // The expensive forecast is requested independently; it must not delay the first fact screen.
        const projection = query.includeForecast === 'true' && month.key === currentMonth() ? await this.reports.workspaceReport('revenue_profit_forecast', scope, month.key, query.manager) as any : null;
        const metricsFor = (id: string | null) => metricKeys.map(metric => {
            const fact = metric === 'payments' ? Number(id ? report.rows?.find((r: any) => r.groupId === id)?.metrics?.[paymentMetric]?.value || 0
                : report.summaryRows?.[0]?.metrics?.[paymentMetric]?.value || 0)
                : assembly.filter(d => shippedIds.has(d.dealId) && (!id || assignments.get(d.dealId)?.managerId === id)).reduce((s, d) => s + Number(d.amount), 0);
            const plan = planRows.find(p => p.metric === metric && p.targetType === (id ? 'MANAGER' : 'GROUP') && p.targetId === (id || department.groupId));
            const value = plan ? Number(plan.value) : null;
            const expectedOpen = !projection?.ready ? null : metric === 'payments'
                ? (projection.paymentProjection?.deals || []).filter((d: any) => !id || d.managerId === id).reduce((s: number, d: any) => s + Number(d.amount) * Number(d.probabilityPercent || 0) / 100, 0)
                : (projection.rows || []).filter((r: any) => !['salesShippedThisMonth', 'repeatShippedThisMonth'].includes(r.id)).flatMap((r: any) => r.deals || []).filter((d: any) => !id || d.managerId === id).reduce((s: number, d: any) => s + Number(d.revenue || 0), 0);
            const forecast = expectedOpen == null ? null : fact + expectedOpen;
            return { metric, plan: value, version: plan?.version || 0, fact, completion: value ? fact / value * 100 : null,
                remaining: value == null ? null : Math.max(value - fact, 0), forecast, forecastDelta: forecast == null || value == null ? null : forecast - value, currency: plan?.currency || 'EUR' };
        });
        const rows = names.map(m => ({ id: m.id, name: m.name, values: metricsFor(m.id) }));
        const incompleteShipments=await this.hasUnassignedShipments(department,month);
        const total = scope.role === 'MANAGER' || query.manager ? null : { id: department.groupId, name: department.name, values: metricsFor(null) };
        const planReconciliation=total?total.values.map(value=>{const individual=rows.map(row=>row.values.find(v=>v.metric===value.metric)!);const sum=individual.reduce((s,v)=>s+(v.plan??0),0);return {metric:value.metric,individualSum:sum,missingPlans:individual.filter(v=>v.plan==null).length,departmentPlan:value.plan,difference:value.plan==null?null:value.plan-sum};}):null;
        return { month: month.key, department: department.name, canEdit: scope.role !== 'MANAGER', rows,
            total,planReconciliation,dataStatus:(report as any).dataStatus,
            incompleteShipments, paymentDefinition: definition ? 'Действия «Оплачен» amoCRM; не банковский реестр' : null };
    }
    async savePlan(userId: string, body: Record<string, any>) {
        const { scope, department, month } = await this.context(userId, { department: body.department, month: body.month, ...(body.targetType === 'MANAGER' ? { manager: body.targetId } : {}) });
        if (scope.role === 'MANAGER')
            throw new ForbiddenException('Менеджер не может изменять план');
        if (!metricKeys.includes(body.metric) || !['MANAGER', 'GROUP'].includes(body.targetType))
            throw new BadRequestException('Некорректный показатель или получатель плана');
        if (body.targetType === 'GROUP' && body.targetId !== department.groupId)
            throw new ForbiddenException('Чужой план недоступен');
        const value = Number(body.value);
        if (!Number.isFinite(value) || value < 0 || value > 1e12 || body.value === '' || body.value == null)
            throw new BadRequestException('Укажите неотрицательный план');
        return this.prisma.$transaction(async (tx) => {
            const where = { month: month.key, departmentKey: department.key, targetType: body.targetType, targetId: String(body.targetId), metric: body.metric };
            const old = await tx.workspacePlan.findUnique({ where: { month_departmentKey_targetType_targetId_metric: where } });
            if ((old?.version || 0) !== Number(body.version))
                throw new ConflictException('План уже изменён. Обновите данные');
            const plan = old ? await tx.workspacePlan.update({ where: { id: old.id, version: old.version }, data: { value, version: { increment: 1 } } })
                : await tx.workspacePlan.create({ data: { ...where, value } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.plan.updated', entity: 'WorkspacePlan', entityId: plan.id,
                    metadata: { ...where, before: old ? String(old.value) : null, after: String(plan.value) } } });
            return { id: plan.id, version: plan.version };
        }).catch(error=>{if(['P2002','P2025','P2034'].includes(error?.code))throw new ConflictException('План уже изменён другим пользователем. Обновите данные');throw error;});
    }
    private async hasUnassignedShipments(department:{assemblyPipelineId:string;shippingStageId:string},month:{start:Date;end:Date}){
        const shipped=await this.prisma.factStageTransition.findMany({where:{toStageId:department.shippingStageId,movedAt:{gte:month.start,lte:month.end}},select:{dealId:true}});
        const relevant=await this.prisma.factDealCurrent.findMany({where:{pipelineId:department.assemblyPipelineId,deletedAt:null,OR:[{stageIsWon:false,stageIsLost:false},{dealId:{in:shipped.map(t=>t.dealId)}}]},select:{dealId:true}});
        const confirmed=await this.prisma.commercialShipmentLink.findMany({where:{status:'CONFIRMED',shipmentDealId:{in:relevant.map(d=>d.dealId)}},select:{shipmentDealId:true}});
        const known=new Set(confirmed.map(link=>link.shipmentDealId));return relevant.some(deal=>!known.has(deal.dealId));
    }
    async deals(userId: string, query: Record<string, string>) {
        const { scope, department, managers, month } = await this.context(userId, query);
        const shipping = query.kind === 'shipments'||query.shipped==='true';
        const linkRows = shipping ? await this.prisma.commercialShipmentLink.findMany({ where: { departmentKey: department.key, status: 'CONFIRMED', managerId: { in: managers } } }) : [];
        const where: any = { deletedAt: null, stageIsWon: false, stageIsLost: false,
            ...(shipping ? { pipelineId: department.assemblyPipelineId, dealId: { in: linkRows.map(l => l.shipmentDealId) } }
                : { pipelineId: { in: department.pipelineIds }, responsibleId: { in: managers } }) };
        if(shipping&&query.shipped==='true'){
            delete where.stageIsWon;delete where.stageIsLost;
            const moved=await this.prisma.factStageTransition.findMany({where:{dealId:{in:linkRows.map(l=>l.shipmentDealId)},toStageId:department.shippingStageId,movedAt:{gte:month.start,lte:month.end}},select:{dealId:true}});
            where.dealId={in:[...new Set(moved.map(t=>t.dealId))]};
        }
        if (query.stage)
            where.stageId = query.stage;
        if (query.search)
            where.title = { contains: query.search.slice(0, 120), mode: 'insensitive' };
        const data = await this.prisma.factDealCurrent.findMany({ where, orderBy: { updatedAt: 'asc' } });
        const intervals = data.length ? await this.prisma.factDealStageInterval.findMany({ where: { dealId: { in: data.map(d => d.dealId) }, isCurrent: true }, select: { dealId: true, stageId: true, enteredAt: true }, orderBy: { enteredAt: 'desc' } }) : [];
        const rules = await this.prisma.ropStageSlaRule.findMany({ where: { departmentKey: department.key } });
        const deliveryField = shipping ? await this.prisma.customFieldDefinition.findFirst({ where: { entityType: 'LEAD', name: { equals: 'Delivery', mode: 'insensitive' } }, select: { externalId: true } }) : null;
        const ruleByStage = new Map(rules.map(r => [r.stageId, r]));
        const linkById = new Map(linkRows.map(l => [l.shipmentDealId, l]));
        const entries = new Map<string, typeof intervals[number]>();
        for (const i of intervals)
            if (!entries.has(i.dealId))
                entries.set(i.dealId, i);
        const now = Date.now();
        const all = data.map(d => {
            const interval = entries.get(d.dealId), rule = ruleByStage.get(d.stageId);
            const enteredAt = interval?.stageId === d.stageId ? interval.enteredAt : null;
            const days = enteredAt ? (now - +enteredAt) / 86400000 : null;
            const knownRule = rule && !/запасной порог|пока нет отдельного/i.test(rule.reason || '');
            const excess = knownRule && rule.isEnabled && rule.slaDays != null && days != null ? Math.max(0, days - rule.slaDays) : null;
            const deliveryValue = deliveryField ? (d.customFields as any)?.[deliveryField.externalId]?.value : null;
            const deliveryDate = deliveryValue == null ? null : typeof deliveryValue === 'number' ? new Date(deliveryValue * 1000) : new Date(String(deliveryValue));
            // CRM Delivery is a calendar date, inclusive through the end of that Moscow day.
            const deliveryDay=deliveryDate&&Number.isFinite(+deliveryDate)?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(deliveryDate):null;
            const deliveryDeadline=deliveryDay?+new Date(`${deliveryDay}T23:59:59.999+03:00`):null;
            const deliveryOverdue = deliveryDeadline!=null&&deliveryDeadline<now;
            const assessment = deliveryOverdue ? 'OVERDUE' : knownRule && !rule.isEnabled ? 'EXCLUDED' : !knownRule || !enteredAt ? 'UNKNOWN' : excess ? 'OVERDUE' : 'OK';
            return { id: d.dealId, externalId: d.dealExternalId, title: d.title, pipeline: d.pipelineName, stageId: d.stageId, stage: d.stageName,
                amount: Number(d.amount), currency: 'EUR', managerId: shipping ? linkById.get(d.dealId)?.managerId : d.responsibleId,
                operationalManager: shipping ? d.responsibleName : null, saleDealId: shipping ? linkById.get(d.dealId)?.saleDealId : null,
                enteredAt, days, limit: knownRule ? rule.slaDays : null, overdueDays: Math.max(excess || 0, deliveryOverdue ? (now - deliveryDeadline!) / 86400000 : 0) || excess, assessment,
                reason: deliveryOverdue ? `Просрочена обещанная дата отгрузки${excess ? '; превышен срок этапа' : ''}` : assessment === 'UNKNOWN' ? !enteredAt ? 'Нет подтверждённой даты входа в этап' : 'Срок для этапа не задан'
                    : assessment === 'OVERDUE' ? 'Превышен срок этапа' : assessment === 'EXCLUDED' ? 'Этап исключён из контроля' : null };
        });
        const selected = query.attention === 'true' && query.shipped!=='true' ? all.filter(d => ['UNKNOWN', 'OVERDUE'].includes(d.assessment)) : all;
        selected.sort((a, b) => query.sort === 'amount' ? b.amount - a.amount : (b.overdueDays || 0) - (a.overdueDays || 0));
        const page = Math.max(1, Math.min(Number(query.page) || 1, 100000));
        return { rows: selected.slice((page - 1) * 50, page * 50), page, pageSize: 50, total: selected.length,
            amount: selected.reduce((s, d) => s + d.amount, 0), unknown: all.filter(d => d.assessment === 'UNKNOWN').length,
            stages: [...new Map(data.map(d => [d.stageId, { id: d.stageId, name: d.stageName }])).values()], role: scope.role };
    }
}
