import { crmControlAnalysisProjection, CrmControlAnalysisSummary } from './crm-control-analysis.projection';
import { CrmControlSemanticRequest, validateCrmControlSemanticResponse } from './crm-control-semantic.validation';

const factNames: Record<string, string> = {
  action: 'Следующее действие', stage_relevance: 'Соответствие этапу', transfer_reason: 'Причина переноса презентации',
  presentation_date: 'Дата презентации', manager_note: 'Примечание менеджера', customer_agreement: 'Договорённость клиента',
  agreed_deadline: 'Согласованный срок', price_delay_reason: 'Причина задержки цены',
};
const sourceNames: Record<string, string> = { task: 'Задача', manager_note: 'Примечание', customer_message: 'Сообщение клиента',
  supplier_message: 'Сообщение поставщика', message: 'Сообщение', call_transcript: 'Расшифровка звонка' };

/** Called only after the observation ACL. No private paths, prompts or unchecked model prose leave this projection. */
export function crmControlAnalysisProof(job: CrmControlAnalysisSummary & { snapshotHash: string; request: unknown },
  snapshotHash: string, attempt: { rawResponse: unknown } | null) {
  const summary = crmControlAnalysisProjection([job]);
  const empty = { analysis: summary, findings: [] as Array<{ fact: string; label: string; state: string; date: unknown;
    evidence: Array<{ sourceId: string; sourceHash: string; label: string; createdAt: string | null; quote: string; text: string }> }> };
  if (!summary?.outcome || job.snapshotHash !== snapshotHash || !attempt?.rawResponse) return empty;
  const request = job.request as CrmControlSemanticRequest;
  const response = (attempt.rawResponse as { response?: unknown }).response;
  const validation = validateCrmControlSemanticResponse(request, response);
  if (validation.status !== 'VALIDATED') return empty;
  const sources = new Map(request.sources.map(source => [source.id, source]));
  return { analysis: summary, findings: validation.findings.map(finding => ({ fact: finding.fact, label: factNames[finding.fact],
    state: finding.state, date: finding.date ?? null, evidence: finding.evidence.map(citation => {
      const source = sources.get(citation.sourceId)!;
      return { sourceId: source.id, sourceHash: source.sourceHash, label: sourceNames[source.kind], createdAt: source.createdAt,
        quote: citation.quote, text: source.text };
    }) })) };
}
