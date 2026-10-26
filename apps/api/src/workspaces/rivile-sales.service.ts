import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { parseRivileDocument, RivileDocument } from './rivile-sales';
import { performancePeriod } from './performance-period';

@Injectable()
export class RivileSalesService {
    private busy = false;
    private readonly logger = new Logger(RivileSalesService.name);
    constructor(private readonly prisma: PrismaService) {}

    async read(month: string, start: Date, end: Date, departmentKey: string) {
        const [snapshot, links] = await Promise.all([
            this.prisma.rivileSalesSnapshot.findUnique({ where: { month } }),
            this.prisma.rivileManagerLink.findMany(),
        ]);
        const byCode = new Map(links.map(link => [link.code, link]));
        const all = (snapshot?.documents || []) as unknown as RivileDocument[];
        const dateFrom = new Date(+start + 10800000).toISOString().slice(0, 10), dateTo = new Date(+end + 10800000).toISOString().slice(0, 10);
        const documents = all.filter(d => d.date >= dateFrom && d.date < dateTo);
        const unknown = [...new Set(documents.filter(d => !byCode.has(d.managerCode) || (byCode.get(d.managerCode)?.departmentKey && !byCode.get(d.managerCode)?.crmUserId)).map(d => d.managerCode || '(empty)'))];
        const past = month < performancePeriod({}).month;
        const monthEnd = new Date(+performancePeriod({ month }).monthEnd + 10800000).toISOString().slice(0, 10);
        const fresh = Boolean(snapshot?.cutoffAt && !snapshot.lastError && Date.now() - +snapshot.cutoffAt < (past ? 86400000 : 900000) && (!past || (snapshot.throughDate || '') >= monthEnd));
        const reason = !snapshot?.cutoffAt ? 'Ривиле: данные ещё не загружены' : snapshot.lastError ? 'Ривиле: обновление завершилось ошибкой' : !fresh ? 'Ривиле: требуется обновление или догрузка полного месяца' : unknown.length ? 'Ривиле: есть документы без подтверждённого менеджера' : null;
        return {
            source: { status: reason ? 'CHECKING' : 'CERTIFIED', reason, cutoffAt: snapshot?.cutoffAt || null, requestedAt: snapshot?.requestedAt || null },
            unknownCodes: unknown, links: links.filter(l => l.departmentKey === departmentKey),
            documents: documents.filter(d => byCode.get(d.managerCode)?.departmentKey === departmentKey).map(d => ({ ...d, managerId: byCode.get(d.managerCode)!.crmUserId! })),
        };
    }

    async request(month: string) {
        performancePeriod({ month });
        if (month > performancePeriod({}).month) throw new Error('Будущий месяц Ривиле недоступен');
        await this.prisma.rivileSalesSnapshot.upsert({ where: { month }, create: { month, requestedAt: new Date(), needsRefresh: true }, update: { requestedAt: new Date(), needsRefresh: true } });
        return { queued: true };
    }

    async ensureMonthlyTargets() {
        const month = performancePeriod({}).month, department = await this.prisma.workspaceDepartment.findUnique({ where: { key: 'sales' } });
        if (!department) return;
        const [profiles, staff, heads] = await Promise.all([
            this.prisma.salesTargetProfile.findMany(),
            this.prisma.crmUser.findMany({ where: { groupId: department.groupId, isActive: true, isVisible: true }, select: { id: true } }),
            this.prisma.user.findMany({ where: { businessRole: { in: ['ROP', 'OWNER'] }, crmUserId: { not: null } }, select: { crmUserId: true } }),
        ]);
        const active = profiles.filter(p => staff.some(u => u.id === p.crmUserId) && !heads.some(h => h.crmUserId === p.crmUserId));
        if (!active.length) return;
        await this.prisma.$transaction(async tx => {
            for (const profile of active) for (const metric of ['paid', 'shipmentMargin']) {
                const scope = { departmentKey: 'sales', period: 'MONTH', start: `${month}-01`, targetType: 'MANAGER', targetId: profile.crmUserId, metric };
                const old = await tx.workspaceKpiGoal.findUnique({ where: { departmentKey_period_start_targetType_targetId_metric: scope } });
                if (old) continue;
                const goal = await tx.workspaceKpiGoal.create({ data: { ...scope, value: metric === 'paid' ? profile.paidTarget : profile.marginTarget } });
                await tx.auditLog.create({ data: { action: 'workspace.sales-target.month-created', entity: 'WorkspaceKpiGoal', entityId: goal.id, metadata: { ...scope, profileVersion: profile.version, value: String(goal.value) } } });
            }
            for (const metric of ['paid', 'shipmentMargin']) {
                const scope = { departmentKey: 'sales', period: 'MONTH', start: `${month}-01`, targetType: 'GROUP', targetId: department.groupId, metric };
                const goals = await tx.workspaceKpiGoal.findMany({ where: { departmentKey: 'sales', period: 'MONTH', start: scope.start, targetType: 'MANAGER', targetId: { in: active.map(p => p.crmUserId) }, metric } });
                await tx.workspaceKpiGoal.upsert({ where: { departmentKey_period_start_targetType_targetId_metric: scope }, create: { ...scope, value: goals.reduce((s, g) => s + Number(g.value), 0) }, update: {} });
            }
        }, { isolationLevel: 'Serializable' });
    }

    @Interval(60000)
    async tick() {
        if (!['sync', 'all'].includes(process.env.WORKER_ROLE || 'api') || !process.env.RIVILE_API_KEY || this.busy) return;
        this.busy = true;
        try {
            await this.ensureMonthlyTargets();
            const month = performancePeriod({}).month;
            const requested = await this.prisma.rivileSalesSnapshot.findMany({ where: { needsRefresh: true, OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(Date.now() - 60000) } }] }, orderBy: { lastAttemptAt: { sort: 'asc', nulls: 'first' } }, take: 2 });
            const current = await this.prisma.rivileSalesSnapshot.findUnique({ where: { month } });
            const pending = new Set(requested.map(r => r.month));
            if (!current?.lastAttemptAt || Date.now() - +current.lastAttemptAt >= 300000) pending.add(month);
            const previousMonth = new Date(+performancePeriod({}).monthStart - 86400000).toISOString().slice(0, 7);
            const previous = await this.prisma.rivileSalesSnapshot.findUnique({ where: { month: previousMonth } });
            if (!previous?.lastAttemptAt || Date.now() - +previous.lastAttemptAt >= 3600000) pending.add(previousMonth);
            for (const key of pending) await this.refresh(key).catch(() => this.logger.warn(`Rivile refresh failed for ${key}; last successful snapshot retained`));
        } finally { this.busy = false; }
    }

    async refresh(month: string) {
        performancePeriod({ month });
        const startedAt = new Date(), runId = randomUUID();
        await this.prisma.rivileSalesSnapshot.upsert({ where: { month }, create: { month }, update: {} });
        const claim = await this.prisma.rivileSalesSnapshot.updateMany({ where: { month, OR: [{ leaseUntil: null }, { leaseUntil: { lt: startedAt } }] }, data: { runId, leaseUntil: new Date(+startedAt + 180000), lastAttemptAt: startedAt } });
        if (!claim.count) return { skipped: true };
        try {
            const deadline = Date.now() + 140000;
            const first = await this.load(month, deadline), second = await this.load(month, deadline);
            const canonical = (rows: RivileDocument[]) => JSON.stringify([...rows].sort((a,b)=>a.id.localeCompare(b.id)));
            if (first.throughDate !== second.throughDate || canonical(first.documents) !== canonical(second.documents)) throw new Error('SOURCE_CHANGED_DURING_READ');
            const { documents, throughDate } = second;
            const result = await this.prisma.rivileSalesSnapshot.updateMany({ where: { month, runId }, data: { documents, throughDate, cutoffAt: startedAt, lastError: null, runId: null, leaseUntil: null } });
            if (!result.count) throw new Error('LEASE_LOST');
            await this.prisma.rivileSalesSnapshot.updateMany({ where: { month, OR: [{ requestedAt: null }, { requestedAt: { lte: startedAt } }] }, data: { needsRefresh: false } });
            return { month, documents: documents.length, cutoffAt: startedAt };
        } catch {
            await this.prisma.rivileSalesSnapshot.updateMany({ where: { month, runId }, data: { lastError: 'SOURCE_REFRESH_FAILED', runId: null, leaseUntil: null } });
            throw new Error('Rivile source refresh failed; previous snapshot retained');
        }
    }

    private async load(month: string, deadline = Date.now() + 120000): Promise<{ documents: RivileDocument[]; throughDate: string }> {
        if (month > performancePeriod({}).month) throw new Error('FUTURE_MONTH');
        if (!process.env.RIVILE_API_KEY) throw new Error('RIVILE_NOT_CONFIGURED');
        const endpoint = process.env.RIVILE_API_URL || 'https://api.manorivile.lt/client/v2';
        if (endpoint !== 'https://api.manorivile.lt/client/v2') throw new Error('RIVILE_ENDPOINT_NOT_ALLOWED');
        if (process.env.RIVILE_BASE_CURRENCY && process.env.RIVILE_BASE_CURRENCY !== 'EUR') throw new Error('RIVILE_BASE_CURRENCY_NOT_EUR');
        const period = performancePeriod({ month });
        const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const tomorrow = new Date(+new Date(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        const toExclusive = [new Date(+period.monthEnd + 10800000).toISOString().slice(0, 10), tomorrow].sort()[0];
        const from = `${month}-01`, seen = new Map<string, RivileDocument>(), pages = new Set<string>();
        for (let page = 1; page <= 500; page++) {
            if (Date.now() > deadline) throw new Error('SOURCE_DEADLINE');
            let rows: Record<string, any>[] | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (Date.now() >= deadline) throw new Error('SOURCE_DEADLINE');
                if (page > 1 || attempt) await new Promise(resolve => setTimeout(resolve, attempt ? 1500 * attempt : 300));
                const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { Accept: 'application/json', ApiKey: process.env.RIVILE_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET_I06_LIST', params: { fil: `i06_op_tip in (51,52) and i06_dok_data >= '${from}' and i06_dok_data < '${toExclusive}'`, list: 'A', pagenumber: page } }), signal: AbortSignal.timeout(Math.max(1,Math.min(20000,deadline-Date.now()))) });
                if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
                if (!response.ok) throw new Error('SOURCE_HTTP_ERROR');
                const data = await response.json() as any;
                const raw = data?.I06 ?? data?.RET_DOK?.I06;
                if (raw == null) { if (data && Object.keys(data).length === 0) rows = []; else throw new Error('UNRECOGNIZED_SOURCE_RESPONSE'); }
                else rows = Array.isArray(raw) ? raw : [raw];
                break;
            }
            if (!rows) throw new Error('SOURCE_UNAVAILABLE');
            const fingerprint = rows.map(row => String(row.I06_KODAS_PO)).join('|');
            if (rows.length && pages.has(fingerprint)) throw new Error('REPEATED_PAGE');
            pages.add(fingerprint);
            for (const row of rows) { const document = parseRivileDocument(row, from, toExclusive); if (document) { const old = seen.get(document.id); if (old && JSON.stringify(old) !== JSON.stringify(document)) throw new Error('CONFLICTING_DOCUMENT'); seen.set(document.id, document); } }
            if (rows.length < 100) return { documents: [...seen.values()], throughDate: toExclusive };
        }
        throw new Error('INCOMPLETE_PAGINATION');
    }
}
