import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CrmControlAnalysisJob, Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { CRM_CONTROL_LOCAL_PROMPT_VERSION, CrmControlLocalSemanticClient, CrmControlLocalSemanticOptions,
  CrmControlLocalSemanticResult, localCrmAnalysisOrigin } from './crm-control-local-semantic.client';
import { CRM_CONTROL_SEMANTIC_FACTS, CrmControlSemanticRequest, validateCrmControlSemanticResponse } from './crm-control-semantic.validation';
import { buildCrmControlSemanticRequest } from './crm-control-semantic.request';
import { CRM_CONTROL_SEMANTIC_POLICY_VERSION, assessCrmControlSemantic } from './crm-control-semantic.policy';
import { canonicalCrmControlSemanticJson as canonical, crmControlSemanticInputHash } from './crm-control-semantic.identity';
import { CrmControlBrowserSourceService } from './crm-control-browser-source.service';
import { appendCrmControlArchivedChatSources } from './crm-control-semantic.chat';
import { appendCrmControlArchivedMailSources } from './crm-control-semantic.mail';

export const CRM_CONTROL_ANALYZER_VERSION = '4';
const ATTEMPTS_PER_REQUEST = 3;
const LEASE_MS = 5 * 60_000; // Longer than the client's hard 180-second request limit.
const ACTIVE_KEY = 'local-semantic';
const RETIRE_BATCH_SIZE = 100;
const HASH = /^[a-f0-9]{64}$/;
const TRANSIENT = new Set(['LOCAL_AI_UNAVAILABLE', 'LOCAL_AI_TIMEOUT', 'LOCAL_AI_STORAGE_UNAVAILABLE']);
const RULE_CHECK: Record<string, CrmControlSemanticRequest['check']> = {
  task_text: 'task_action', proposal_note: 'proposal_note', task_stage_deadline: 'deadline_agreement',
  stage_duration: 'deadline_agreement', price_requested_duration: 'price_delay',
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const sameDate = (left: unknown, right: unknown) => left == null && right == null
  || typeof left === 'string' && typeof right === 'string' && Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);

export function crmControlLocalAnalysisOptions(env: NodeJS.ProcessEnv = process.env): CrmControlLocalSemanticOptions | null {
  const origin = env.CRM_CONTROL_LOCAL_AI_ORIGIN;
  const model = env.CRM_CONTROL_LOCAL_AI_MODEL;
  const modelSha256 = env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256;
  const cacheDirectory = env.CRM_CONTROL_LOCAL_AI_CACHE_DIR;
  const timeoutMs = env.CRM_CONTROL_LOCAL_AI_TIMEOUT_MS ? Number(env.CRM_CONTROL_LOCAL_AI_TIMEOUT_MS) : 120_000;
  if (!origin || !model?.trim() || model.length > 256 || !modelSha256 || !HASH.test(modelSha256)
    || !cacheDirectory || !path.isAbsolute(cacheDirectory) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) return null;
  try { return { origin: localCrmAnalysisOrigin(origin), model, modelSha256, cacheDirectory, timeoutMs }; }
  catch { return null; }
}

@Injectable()
export class CrmControlAnalysisService {
  private busy = false;
  constructor(private readonly prisma: PrismaService, private readonly browserSources?: CrmControlBrowserSourceService) {}

  /** Internal only: callers build sources from this archived observation, never from a fresh CRM read. */
  async enqueue(resultId: string, snapshotHash: string, supplied: CrmControlSemanticRequest) {
    const options = crmControlLocalAnalysisOptions();
    if (!options) return { status: 'DISABLED' as const, code: 'LOCAL_AI_NOT_CONFIGURED' as const };
    const result = await this.prisma.crmControlResult.findUnique({ where: { id: resultId }, include: { observation: { include: { run: true } } } });
    if (!result) throw new NotFoundException('Сохранённый результат проверки не найден.');
    const observation = result.observation;
    const snapshot = observation.snapshot as any;
    const details = result.details as any;
    if (!supplied || !Array.isArray(supplied.sources) || !HASH.test(snapshotHash) || snapshotHash !== observation.snapshotHash
      || supplied.dealId !== observation.dealId || !observation.managerId || supplied.ownerId !== observation.managerId
      || (supplied.subjectId ?? '') !== result.subjectId || RULE_CHECK[result.ruleCode] !== supplied.check
      || Date.parse(supplied.observedAt) !== observation.observedAt.getTime() || supplied.stageName !== observation.stageName
      || supplied.timeZone !== (observation.run.config as any)?.timeZone
      || !sameDate(supplied.taskDueAt, details?.dueAt) || !sameDate(supplied.maxDueAt, details?.maximumDueAt)
      || (supplied.stageEnteredAt == null ? snapshot?.stageEnteredAt != null : Date.parse(supplied.stageEnteredAt) !== Date.parse(snapshot?.stageEnteredAt))
      || !supplied.coverage || ['tasks', 'notes', 'communications'].some(key => supplied.coverage[key as keyof typeof supplied.coverage] === true
        && snapshot?.sourceCompleteness?.[key] !== true)) throw new BadRequestException('Запрос анализа не соответствует сохранённым данным проверки.');
    const expected = buildCrmControlSemanticRequest(observation, result);
    if (!expected || canonical({ ...supplied, requestId: undefined }) !== canonical({ ...expected, requestId: undefined })) {
      throw new BadRequestException('Источники анализа не соответствуют сохранённым данным проверки.');
    }
    let trusted = expected;
    const browser = snapshot?.browserSources;
    if (this.browserSources && ['deadline_agreement', 'price_delay'].includes(expected.check) && browser?.manifest
      && typeof browser.connectionId === 'string' && typeof browser.accountExternalId === 'string' && observation.dealExternalId) {
      const connection = await this.prisma.amoConnection.findUnique({ where: { id: browser.connectionId }, select: { id: true, accountId: true } });
      if (connection && connection.accountId === browser.accountExternalId) {
        try {
          const manifest = await this.browserSources.readManifest(browser.manifest, observation.dealExternalId);
          trusted = appendCrmControlArchivedChatSources(observation, expected, manifest, connection);
          trusted = appendCrmControlArchivedMailSources(observation, trusted, manifest, connection);
        } catch { /* A missing/corrupt private archive is never replaced with caller-provided chat text. */ }
      }
    }
    const preflight = validateCrmControlSemanticResponse(trusted, { schemaVersion: 1, requestId: trusted.requestId,
      check: trusted.check, subjectId: trusted.subjectId, inspectedSourceIds: trusted.sources.map(source => source?.id),
      findings: CRM_CONTROL_SEMANTIC_FACTS[trusted.check]?.map(fact => ({ fact, state: 'uncertain', evidence: [] })) });
    if (preflight.status === 'INVALID') throw new BadRequestException('Некорректные источники анализа.');
    // Preserve the trusted builder's stable ID; ignore only an arbitrary caller's replacement ID.
    const request = JSON.parse(canonical(trusted)) as CrmControlSemanticRequest;
    const inputHash = crmControlSemanticInputHash(request, { promptVersion: CRM_CONTROL_LOCAL_PROMPT_VERSION,
      model: options.model, modelSha256: options.modelSha256 });
    return this.prisma.crmControlAnalysisJob.upsert({
      where: { resultId_inputHash_analyzerVersion: { resultId, inputHash, analyzerVersion: CRM_CONTROL_ANALYZER_VERSION } }, update: {},
      create: { resultId, snapshotHash, inputHash, analyzerVersion: CRM_CONTROL_ANALYZER_VERSION,
        promptVersion: CRM_CONTROL_LOCAL_PROMPT_VERSION, model: options.model, modelSha256: options.modelSha256, request: json(request) },
    });
  }

  /** Internal manual action only. Automatic enqueue/process calls must never extend an exhausted budget. */
  async retryTransientError(jobId: string, requestKey: string): Promise<boolean> {
    if (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 256) return false;
    try {
      return await this.prisma.$transaction(async tx => {
        const previous = await tx.crmControlAnalysisRetryGrant.findUnique({ where: { jobId_requestKey: { jobId, requestKey } } });
        if (previous) return false;
        const job = await tx.crmControlAnalysisJob.findUnique({ where: { id: jobId } });
        if (!job || job.status !== 'ERROR' || !job.errorCode || (!TRANSIENT.has(job.errorCode) && job.errorCode !== 'LEASE_EXPIRED')) return false;
        const attemptLimit = job.attemptCount + ATTEMPTS_PER_REQUEST;
        const changed = await tx.crmControlAnalysisJob.updateMany({ where: { id: job.id, status: 'ERROR',
          errorCode: job.errorCode, attemptCount: job.attemptCount, attemptLimit: job.attemptLimit, finishedAt: job.finishedAt }, data: {
          status: 'QUEUED', attemptLimit, activeKey: null, leaseToken: null, leaseUntil: null,
          nextAttemptAt: null, finishedAt: null, errorCode: null, assessmentStatus: 'UNKNOWN',
          assessmentMessage: 'Запрошена повторная попытка локального анализа.', policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION,
        } });
        if (!changed.count) return false;
        // Permanent, append-only idempotency survives A → B → replay(A), process restarts and page retries.
        await tx.crmControlAnalysisRetryGrant.create({ data: { jobId, requestKey, attemptLimit } });
        return true;
      });
    } catch (error: any) {
      if (error?.code === 'P2002') return false; // Duplicate grant rolls back the budget update in the same transaction.
      throw error;
    }
  }

  /** Each expired lease produces a terminal attempt record; a late writer cannot append over it. */
  private async recoverExpired(now: Date) {
    const expired = await this.prisma.crmControlAnalysisJob.findFirst({ where: { status: 'RUNNING', activeKey: ACTIVE_KEY, leaseUntil: { lte: now } } });
    if (!expired) return;
    await this.prisma.$transaction(async tx => {
      const retryable = expired.attemptCount < expired.attemptLimit;
      const changed = await tx.crmControlAnalysisJob.updateMany({ where: { id: expired.id, status: 'RUNNING',
        leaseToken: expired.leaseToken, leaseUntil: { lte: now } }, data: { status: retryable ? 'QUEUED' : 'ERROR', activeKey: null,
        leaseToken: null, leaseUntil: null, nextAttemptAt: retryable ? now : null, finishedAt: retryable ? null : now, errorCode: 'LEASE_EXPIRED',
        assessmentStatus: 'UNKNOWN', assessmentMessage: 'Попытка локального анализа прервалась до завершения.', policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION } });
      if (!changed.count) return;
      await tx.crmControlAnalysisAttempt.create({ data: { jobId: expired.id, attemptNo: expired.attemptCount,
        leaseToken: expired.leaseToken!, status: 'ERROR', errorCode: 'LEASE_EXPIRED', retryable,
        startedAt: expired.startedAt!, finishedAt: now } });
    });
  }

  /** Retire a bounded page without spending model attempts or changing an active request/history. */
  private async retireOutdatedQueued(now: Date, options: CrmControlLocalSemanticOptions) {
    const outdated = { OR: [{ analyzerVersion: { not: CRM_CONTROL_ANALYZER_VERSION } },
      { promptVersion: { not: CRM_CONTROL_LOCAL_PROMPT_VERSION } }, { model: { not: options.model } },
      { modelSha256: { not: options.modelSha256 } }] };
    const rows = await this.prisma.crmControlAnalysisJob.findMany({ where: { status: 'QUEUED', ...outdated },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: RETIRE_BATCH_SIZE, select: { id: true } });
    if (!rows.length) return;
    await this.prisma.crmControlAnalysisJob.updateMany({ where: { id: { in: rows.map(row => row.id) }, status: 'QUEUED', ...outdated },
      data: { status: 'ERROR', errorCode: 'LOCAL_AI_VERSION_CHANGED', finishedAt: now, nextAttemptAt: null,
        activeKey: null, leaseToken: null, leaseUntil: null, assessmentStatus: 'UNKNOWN',
        assessmentMessage: 'Настройки анализатора изменились; требуется новая допроверка.', policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION } });
  }

  private async claim(now: Date, options = crmControlLocalAnalysisOptions()): Promise<CrmControlAnalysisJob | null> {
    if (!options) return null;
    const candidate = await this.prisma.crmControlAnalysisJob.findFirst({ where: { status: 'QUEUED',
      analyzerVersion: CRM_CONTROL_ANALYZER_VERSION, promptVersion: CRM_CONTROL_LOCAL_PROMPT_VERSION,
      model: options.model, modelSha256: options.modelSha256,
      attemptCount: { lt: this.prisma.crmControlAnalysisJob.fields.attemptLimit },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!candidate) return null;
    try {
      return await this.prisma.$transaction(async tx => {
        const changed = await tx.crmControlAnalysisJob.updateMany({ where: { id: candidate.id, status: 'QUEUED', attemptCount: candidate.attemptCount,
          attemptLimit: candidate.attemptLimit,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, data: { status: 'RUNNING', activeKey: ACTIVE_KEY,
          leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: now, finishedAt: null,
          nextAttemptAt: null, attemptCount: { increment: 1 } } });
        return changed.count ? tx.crmControlAnalysisJob.findUnique({ where: { id: candidate.id } }) : null;
      });
    } catch (error: any) {
      // The unique activeKey permits exactly one model request across processes, not merely one per scheduler.
      if (error?.code === 'P2002') return null;
      throw error;
    }
  }

  private async finish(job: CrmControlAnalysisJob, outcome: CrmControlLocalSemanticResult | { status: 'ERROR'; code: string; retryable: boolean }) {
    const now = new Date();
    const validation = outcome.status === 'READY' ? validateCrmControlSemanticResponse(job.request as unknown as CrmControlSemanticRequest, outcome.response) : null;
    const identityValid = outcome.status !== 'READY' || (outcome.inputHash === job.inputHash && outcome.modelSha256 === job.modelSha256
      && outcome.model === job.model && outcome.promptVersion === job.promptVersion);
    const errorCode = !identityValid ? 'LOCAL_AI_IDENTITY_MISMATCH' : validation?.status === 'INVALID' ? 'LOCAL_AI_INVALID_RESPONSE'
      : outcome.status === 'ERROR' ? outcome.code : null;
    const retryable = outcome.status === 'ERROR' && outcome.retryable && TRANSIENT.has(outcome.code) && job.attemptCount < job.attemptLimit;
    const cycleAttempt = Math.max(1, job.attemptCount - (job.attemptLimit - ATTEMPTS_PER_REQUEST));
    const rule = validation && !errorCode ? await this.prisma.crmControlResult.findUnique({ where: { id: job.resultId }, select: { ruleCode: true } }) : null;
    const assessment = validation && !errorCode && rule ? assessCrmControlSemantic(job.request as unknown as CrmControlSemanticRequest, validation, rule.ruleCode)
      : { status: 'UNKNOWN', message: 'Локальный анализ пока не дал проверенного результата.', policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION };
    const status = errorCode ? 'ERROR' : assessment.status !== 'UNKNOWN' ? 'READY' : 'UNKNOWN';
    await this.prisma.$transaction(async tx => {
      const changed = await tx.crmControlAnalysisJob.updateMany({ where: { id: job.id, status: 'RUNNING', activeKey: ACTIVE_KEY,
        leaseToken: job.leaseToken, attemptCount: job.attemptCount, leaseUntil: { gt: now } }, data: {
        status: retryable ? 'QUEUED' : status, activeKey: null, leaseToken: null, leaseUntil: null, errorCode,
        assessmentStatus: assessment.status, assessmentMessage: assessment.message, policyVersion: assessment.policyVersion,
        nextAttemptAt: retryable ? new Date(now.getTime() + 30_000 * cycleAttempt) : null, finishedAt: retryable ? null : now,
      } });
      if (!changed.count) return; // Expired/replaced attempt: its result has no authority to change history.
      await tx.crmControlAnalysisAttempt.create({ data: { jobId: job.id, attemptNo: job.attemptCount, leaseToken: job.leaseToken!,
        status, errorCode, retryable, rawResponse: json(outcome), validation: validation ? json(validation) : Prisma.DbNull,
        startedAt: job.startedAt!, finishedAt: now } });
    });
  }

  async processQueue() {
    if (this.busy) return;
    const options = crmControlLocalAnalysisOptions();
    if (!options) return;
    this.busy = true;
    try {
      const now = new Date();
      await this.recoverExpired(now);
      await this.retireOutdatedQueued(now, options);
      const job = await this.claim(now, options);
      if (!job) return;
      if (job.model !== options.model || job.modelSha256 !== options.modelSha256 || job.promptVersion !== CRM_CONTROL_LOCAL_PROMPT_VERSION
        || job.analyzerVersion !== CRM_CONTROL_ANALYZER_VERSION) {
        await this.finish(job, { status: 'ERROR', code: 'LOCAL_AI_VERSION_CHANGED', retryable: false }); return;
      }
      // No network/CRM reload: the exact saved request is the sole source of model input.
      let outcome: CrmControlLocalSemanticResult;
      try { outcome = await new CrmControlLocalSemanticClient(options).analyze(job.request as unknown as CrmControlSemanticRequest); }
      catch { outcome = { status: 'ERROR', code: 'LOCAL_AI_UNAVAILABLE', retryable: true }; }
      await this.finish(job, outcome);
    } finally { this.busy = false; }
  }
}
