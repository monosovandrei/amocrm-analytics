import { CRM_CONTROL_SEMANTIC_POLICY_VERSION } from './crm-control-semantic.policy';
import { CRM_CONTROL_ANALYZER_VERSION, crmControlLocalAnalysisOptions } from './crm-control-analysis.service';
import { CRM_CONTROL_LOCAL_PROMPT_VERSION } from './crm-control-local-semantic.client';

export const crmControlAnalysisSummarySelect = { id: true, status: true, assessmentStatus: true, assessmentMessage: true,
  policyVersion: true, model: true, modelSha256: true, analyzerVersion: true, promptVersion: true,
  errorCode: true, attemptCount: true, createdAt: true, finishedAt: true } as const;
export const crmControlAnalysisSummaryInclude = { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  take: 1, select: crmControlAnalysisSummarySelect };
export interface CrmControlAnalysisSummary {
  id: string; status: string; assessmentStatus: string | null; assessmentMessage: string | null; policyVersion: string | null;
  errorCode: string | null; attemptCount: number; createdAt: Date; finishedAt: Date | null;
  model: string; modelSha256: string; analyzerVersion: string; promptVersion: string;
}
const errors: Record<string, string> = {
  LOCAL_AI_NOT_CONFIGURED: 'Локальный анализ не настроен.', LOCAL_AI_INPUT_LIMIT: 'Объём источников превышает предел одного анализа.',
  LOCAL_AI_UNAVAILABLE: 'Локальный анализатор временно недоступен.', LOCAL_AI_TIMEOUT: 'Анализ не уложился в отведённое время.',
  LOCAL_AI_INVALID_RESPONSE: 'Вывод анализатора не прошёл проверку источников.', LOCAL_AI_STORAGE_UNAVAILABLE: 'Архив анализа временно недоступен.',
  LOCAL_AI_VERSION_CHANGED: 'Настройки анализатора изменились; требуется повторная постановка проверки.',
  LOCAL_AI_IDENTITY_MISMATCH: 'Вывод не соответствует сохранённым исходным данным.', LEASE_EXPIRED: 'Обработка была прервана.',
};

/** Compact projection only. Raw prompts, source bodies and responses are never part of manager summaries. */
export function crmControlAnalysisProjection(jobs?: readonly CrmControlAnalysisSummary[]) {
  const job = jobs?.[0];
  if (!job) return null;
  const options = crmControlLocalAnalysisOptions();
  const currentIdentity = !!options && job.model === options.model && job.modelSha256 === options.modelSha256
    && job.analyzerVersion === CRM_CONTROL_ANALYZER_VERSION && job.promptVersion === CRM_CONTROL_LOCAL_PROMPT_VERSION
    && job.policyVersion === CRM_CONTROL_SEMANTIC_POLICY_VERSION;
  const accepted = job.status === 'READY' && currentIdentity && ['PASS','FAIL'].includes(job.assessmentStatus ?? '');
  return { id: job.id, status: job.status, outcome: accepted ? job.assessmentStatus as 'PASS' | 'FAIL' : null,
    message: job.status === 'QUEUED' ? 'Смысловая проверка поставлена в очередь на сервере.'
      : job.status === 'RUNNING' ? 'Выполняется локальный анализ сохранённых источников.'
        : accepted ? job.assessmentMessage ?? 'Локальная проверка завершена.'
          : job.status === 'ERROR' ? errors[job.errorCode ?? ''] ?? 'Локальная проверка не завершена.'
            : job.status === 'READY' && !currentIdentity ? (options
              ? 'Этот вывод получен другой версией локального анализатора; требуется новая допроверка.'
              : 'Локальный анализ не настроен; сохранённый вывод не используется в итогах проверки.')
            : job.assessmentMessage ?? 'Для однозначного вывода не хватает подтверждённых данных.',
    completedAt: job.finishedAt, attempts: job.attemptCount };
}
