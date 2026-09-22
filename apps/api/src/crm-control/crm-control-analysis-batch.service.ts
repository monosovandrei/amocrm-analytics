import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CRM_CONTROL_ANALYZER_VERSION, CrmControlAnalysisService, crmControlLocalAnalysisOptions } from './crm-control-analysis.service';
import { CRM_CONTROL_LOCAL_PROMPT_VERSION } from './crm-control-local-semantic.client';
import { buildCrmControlSemanticRequest } from './crm-control-semantic.request';

const ACTIVE_KEY = 'analysis-batch';
const RULES = ['task_text','proposal_note','task_stage_deadline','stage_duration','price_requested_duration'];
export interface CrmControlAnalysisScope { role: 'OWNER' | 'ROP' | 'MANAGER'; managerId?: string; groupId?: string }

/** Durable backfill cursor. A page can be repeated safely because per-result enqueue is idempotent. */
@Injectable()
export class CrmControlAnalysisBatchService {
  private busy = false;
  constructor(private readonly prisma: PrismaService, private readonly analysis: CrmControlAnalysisService) {}

  async enqueue(runId: string, scope: CrmControlAnalysisScope, requestKey: string) {
    if (!crmControlLocalAnalysisOptions()) throw new BadRequestException('Локальный анализ ещё не настроен или не прошёл контрольную проверку.');
    if (!['OWNER','ROP','MANAGER'].includes(scope.role) || (scope.role === 'ROP' && !scope.groupId) || (scope.role === 'MANAGER' && !scope.managerId)) {
      throw new BadRequestException('Область допроверки не определена.');
    }
    const pending = await this.prisma.crmControlAnalysisBatch.findFirst({ where: { runId, scopeRole: scope.role,
      managerId: scope.managerId ?? null, groupId: scope.groupId ?? null, status: { in: ['QUEUED','RUNNING'] } } });
    if (pending) return pending;
    return this.prisma.crmControlAnalysisBatch.upsert({ where: { requestKey }, update: {}, create: {
      runId, requestKey, scopeRole: scope.role, managerId: scope.managerId ?? null, groupId: scope.groupId ?? null,
    } });
  }

  async processQueue() {
    const options = crmControlLocalAnalysisOptions();
    if (this.busy || !options) return;
    this.busy = true;
    try {
      const now = new Date();
      await this.prisma.crmControlAnalysisBatch.updateMany({ where: { status: 'RUNNING', leaseUntil: { lte: now } },
        data: { status: 'QUEUED', activeKey: null, leaseToken: null, leaseUntil: null } });
      // Finish the latest saved audit automatically. Historical runs are requested explicitly by the owner.
      const latest = await this.prisma.crmControlRun.findFirst({ where: { status: { in: ['PARTIAL','COMPLETED'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (latest) {
        const access = (latest.config as any)?._access;
        const scope: CrmControlAnalysisScope = access ? { role: access.role, managerId: access.managerId, groupId: access.groupId } : { role: 'OWNER' };
        const version = createHash('sha256').update(JSON.stringify([options.model, options.modelSha256,
          CRM_CONTROL_ANALYZER_VERSION, CRM_CONTROL_LOCAL_PROMPT_VERSION])).digest('hex');
        await this.enqueue(latest.id, scope, `automatic:${latest.id}:${version}`);
      }
      const candidate = await this.prisma.crmControlAnalysisBatch.findFirst({ where: { status: 'QUEUED',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (!candidate) return;
      const leaseToken = randomUUID();
      try {
        const claimed = await this.prisma.crmControlAnalysisBatch.updateMany({ where: { id: candidate.id, status: 'QUEUED' }, data: {
          status: 'RUNNING', activeKey: ACTIVE_KEY, leaseToken, leaseUntil: new Date(now.getTime() + 120_000), errorCode: null,
        } });
        if (!claimed.count) return;
      } catch (error: any) { if (error?.code === 'P2002') return; throw error; }
      const lease = { id: candidate.id, status: 'RUNNING', leaseToken, activeKey: ACTIVE_KEY };
      try {
        if (!['OWNER','ROP','MANAGER'].includes(candidate.scopeRole) || (candidate.scopeRole === 'ROP' && !candidate.groupId)
          || (candidate.scopeRole === 'MANAGER' && !candidate.managerId)) throw new Error('INVALID_SCOPE');
        const rows = await this.prisma.crmControlObservation.findMany({ where: { runId: candidate.runId,
          ...(candidate.scopeRole === 'ROP' ? { groupId: candidate.groupId } : candidate.scopeRole === 'MANAGER' ? { managerId: candidate.managerId } : {}) },
          orderBy: { id: 'asc' }, take: 20, ...(candidate.cursor ? { cursor: { id: candidate.cursor }, skip: 1 } : {}),
          include: { run: { select: { config: true } }, results: { where: { ruleCode: { in: RULES }, status: { in: ['REVIEW','UNKNOWN'] } } } } });
        let queued = 0, deferred = 0;
        for (const observation of rows) for (const result of observation.results) {
          // A resumed worker may have lost its lease while a database call was pending.
          const owned = await this.prisma.crmControlAnalysisBatch.updateMany({ where: { ...lease, leaseUntil: { gt: new Date() } },
            data: { leaseUntil: new Date(Date.now() + 120_000) } });
          if (!owned.count) return;
          const request = buildCrmControlSemanticRequest(observation, result);
          if (!request) { deferred++; continue; }
          try {
            const job = await this.analysis.enqueue(result.id, observation.snapshotHash, request);
            if (job.status === 'DISABLED') throw new Error('LOCAL_AI_NOT_CONFIGURED');
            if (job.status === 'ERROR' && !candidate.requestKey.startsWith('automatic:')) {
              const stillOwned = await this.prisma.crmControlAnalysisBatch.updateMany({ where: { ...lease, leaseUntil: { gt: new Date() } },
                data: { leaseUntil: new Date(Date.now() + 120_000) } });
              if (!stillOwned.count) return;
              await this.analysis.retryTransientError(job.id, candidate.requestKey);
            }
            queued++;
          } catch (error) {
            if (error instanceof BadRequestException) { deferred++; continue; }
            throw error;
          }
        }
        await this.prisma.crmControlAnalysisBatch.updateMany({ where: { ...lease, leaseUntil: { gt: new Date() } }, data: {
          status: rows.length < 20 ? 'COMPLETED' : 'QUEUED', activeKey: null, leaseToken: null, leaseUntil: null,
          cursor: rows.at(-1)?.id ?? candidate.cursor, processed: { increment: rows.length }, queued: { increment: queued }, deferred: { increment: deferred },
          finishedAt: rows.length < 20 ? new Date() : null, retryCount: 0, nextAttemptAt: null,
        } });
      } catch {
        const retry = candidate.retryCount < 2;
        await this.prisma.crmControlAnalysisBatch.updateMany({ where: { ...lease, leaseUntil: { gt: new Date() } }, data: {
          status: retry ? 'QUEUED' : 'ERROR', activeKey: null, leaseToken: null, leaseUntil: null, errorCode: 'ENQUEUE_FAILED',
          retryCount: { increment: 1 }, nextAttemptAt: retry ? new Date(Date.now() + 30_000 * 2 ** candidate.retryCount) : null,
          finishedAt: retry ? null : new Date() } });
      }
    } finally { this.busy = false; }
  }
}
