import { createHash } from 'node:crypto';
import type { CrmControlDocumentAnalysisReference, CrmControlDocumentAnalysisService } from './crm-control-document-analysis.service';
import type { CrmControlDocumentPayload } from './crm-control-local-extraction.client';
import { CrmControlOfferSelection, selectCrmControlOfferCandidate } from './crm-control-offer.selection';
import { anchorCrmControlOfferField, CrmControlOfferFieldAnchor } from './crm-control-offer.field-anchor';
import { CrmControlOfferCitation, CrmControlOfferFile, CrmControlOfferLocator, CrmControlOfferScope, CrmControlOfferTextUnit,
  CrmControlOfferValidation, CrmControlOfferValidationInput, crmControlOfferTextHash, validateCrmControlOffer } from './crm-control-offer.validation';

export interface CrmControlArchivedOfferInput {
  scope: CrmControlOfferScope;
  snapshot: unknown;
  /** Future server-owned coverage attestation. Never copy browser/webhook completeness flags or user/LLM JSON here. */
  trustedHistory?: CrmControlOfferValidationInput['history'];
}
export interface CrmControlArchivedOfferCandidate {
  status: 'CANDIDATE_ONLY'; source: 'field' | 'sent'; sourceId: string; sentAt: string | null; artifactSha256: string | null;
  classification: CrmControlOfferSelection['classification']; selectionStatus: CrmControlOfferSelection['status']; issues: string[];
  amount: { decimal: string; currency: string; evidence: CrmControlOfferCitation[] } | null;
  headingEvidence: CrmControlOfferCitation[];
}
export interface CrmControlArchivedOfferAssessment {
  validation: CrmControlOfferValidation;
  messages: { offer_budget: string; proposal_file: string };
  details: { version: 1; historyStatus: 'VERIFIED_COMPLETE' | 'UNVERIFIED'; issues: string[]; reasons: string[];
    inspectedDocuments: number; candidates: CrmControlArchivedOfferCandidate[]; fieldAnchors?: CrmControlOfferFieldAnchor[] };
}

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as any : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 100;
const digest = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const instant = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString()
  : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
const ISSUE_TEXT: Record<string, string> = {
  DEAL_OWNER_UNVERIFIED: 'Ответственный за сделку не подтверждён; документы не сравнивались.',
  SNAPSHOT_SCOPE_MISMATCH: 'Снимок сделки не совпадает с проверяемой сделкой, ответственным или хешем.',
  INVALID_TRUSTED_HISTORY: 'Подтверждение полной истории не прошло проверку.',
  INCOMPLETE_SENT_HISTORY: 'Нет подтверждения полноты истории отправленных клиенту предложений.',
  CONTACT_MAIL_NOT_BOUND: 'Вложения письма контакта не привязаны к этой сделке и исключены из сравнения.',
  FIELD_ANCHOR_SCOPE_INVALID: 'Исходные данные для сопоставления отправки файла «КП» не подтверждены.',
  FIELD_ANCHOR_LIMIT: 'Достигнут предел сопоставления вложений с полем «КП».',
  FIELD_ANCHOR_SOURCE_INVALID: 'Для части почтовых вложений не подтверждены идентификаторы отправки.',
  FIELD_ANCHOR_SOURCE_CONFLICT: 'Для одного почтового вложения сохранены противоречивые данные.',
  FIELD_ANCHOR_TIME_UNVERIFIED: 'Отправку файла нельзя отнести к периоду этой проверки.',
  FIELD_ANCHOR_IDENTITY_CONFLICT: 'Одна версия файла имеет разные хеши байтов; отправка не подтверждена.',
  FIELD_ANCHOR_LATER_UNBOUND_ATTACHMENTS: 'После совпавшего файла в той же почтовой цепочке есть другие непривязанные вложения; последняя версия КП не установлена.',
  FIELD_ANCHOR_ORDER_UNVERIFIED: 'Порядок других непривязанных вложений в этой почтовой цепочке не подтверждён; последняя версия КП не установлена.',
  FIELD_ANCHOR_CONTENT_NOT_AUTHORIZED: 'Отправленная версия совпала с полем «КП» по UUID, но совпадение байтов не подтверждено; содержимое письма не читалось.',
  DOCUMENT_NOT_ARCHIVED: 'Вложение не удалось сохранить для проверки.',
  DOCUMENT_EXTRACTION_UNAVAILABLE: 'Нет доступного результата чтения сохранённого файла.',
  DOCUMENT_EXTRACTION_UNVERIFIED: 'Текст файла извлечён не полностью либо содержит OCR или формулы.',
  DOCUMENT_TEXT_INVALID: 'Текст файла или его расположение не прошли проверку.',
  DOCUMENT_REFERENCE_CONFLICT: 'Для файла обнаружены противоречивые результаты чтения.',
  DOCUMENT_ANALYSIS_LIMIT: 'Достигнут предел числа файлов для этой проверки.',
  SENT_SOURCE_INVALID: 'Не подтверждён идентификатор или момент отправки вложения.',
  SENT_HISTORY_CONFLICT: 'Архивные вложения расходятся с подтверждённой историей отправки.',
  EXPLICIT_OFFER_HEADING_NOT_FOUND: 'В файле не найден явный заголовок коммерческого предложения.',
  EXPLICIT_FINAL_TOTAL_NOT_FOUND: 'В предложении не найден единственный явно подписанный итог.',
  MULTIPLE_OFFER_TOTALS: 'В предложении найдено несколько итоговых сумм.',
  OFFER_CURRENCY_AMBIGUOUS: 'Валюта итога не определена однозначно.',
  OFFER_AMOUNT_QUALIFIED_OR_ALTERNATIVE: 'В предложении указана предварительная цена или альтернативные варианты.',
  FINAL_TOTAL_FORMAT_UNVERIFIED: 'Не удалось однозначно прочитать итог и валюту предложения.',
  MULTIPLE_PROPOSALS_IN_MESSAGE: 'В одном сообщении найдены разные файлы коммерческих предложений.',
  NO_ARCHIVED_SENT_OFFER: 'Среди доступных отправленных вложений не найдено подтверждённого КП.',
  PROPOSAL_FIELD_INCOMPLETE: 'Поле «КП» прочитано не полностью либо версия файла не определена.',
  INVALID_MONEY_DECIMAL: 'Бюджет сделки не сохранён в точном денежном формате.',
  CURRENCY_MISMATCH_OR_UNKNOWN: 'Валюта бюджета и предложения различается либо не определена.',
  LATEST_OFFER_NOT_VERIFIED: 'Последнее отправленное предложение не определено однозначно.',
  LATEST_OFFER_ORDER_AMBIGUOUS: 'У нескольких отправленных предложений одинаковое время.',
  OFFER_AMOUNT_UNVERIFIED: 'Итог последнего предложения не подтверждён.',
  AMBIGUOUS_OFFER_TOTAL: 'Итог последнего предложения неоднозначен.',
  LATEST_PROPOSAL_FILE_UNVERIFIED: 'Файл последней отправленной версии КП не подтверждён.',
  AMOUNT_OR_CURRENCY_NOT_GROUNDED: 'Цитата суммы или валюты не прошла проверку по сохранённому тексту.',
};

type NativeUnit = { text: string; locator: CrmControlOfferLocator };
type Loaded = { units: NativeUnit[]; issue?: string };
type Candidate = { source: 'field' | 'sent'; sourceId: string; sentAt: string | null; artifactSha256: string | null;
  file: CrmControlOfferFile | null; selection: CrmControlOfferSelection; textUnits: CrmControlOfferTextUnit[] };

function nativeUnits(payload: CrmControlDocumentPayload, sha256: string): Loaded {
  if (payload.sourceSha256 !== sha256 || payload.extractorVersion !== 'local-documents-v1'
    || !['pdf', 'docx', 'xlsx'].includes(payload.format) || !Array.isArray(payload.units) || !payload.units.length
    || payload.units.length > 50_000 || !Array.isArray(payload.problems)) return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
  if (payload.status !== 'COMPLETE' || payload.problems.length || payload.units.some(unit => unit?.complete !== true || unit?.method !== 'native')) {
    return { units: [], issue: 'DOCUMENT_EXTRACTION_UNVERIFIED' };
  }
  const output: NativeUnit[] = [], pdf = new Map<number, { lines: string[]; previous: number }>(), locators = new Set<string>();
  let total = 0;
  for (const unit of payload.units) {
    const loc = object(unit.locator);
    if (typeof unit.text !== 'string' || unit.text.length > 16_000 || (total += unit.text.length) > 200_000) return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
    if (payload.format === 'pdf') {
      if (loc.kind !== 'pdf' || !Number.isSafeInteger(loc.page) || loc.page < 1 || loc.page > 100
        || !Number.isSafeInteger(loc.line) || loc.line < 1 || loc.coordinateSpace !== 'pdf-points') return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
      const page = pdf.get(loc.page) ?? { lines: [], previous: 0 };
      if (loc.line <= page.previous) return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
      page.previous = loc.line; page.lines.push(unit.text); pdf.set(loc.page, page);
    } else {
      let locator: CrmControlOfferLocator;
      if (payload.format === 'docx' && loc.kind === 'docx' && id(loc.part) && typeof loc.path === 'string' && loc.path.length <= 2048 && loc.path) {
        locator = { kind: 'docx', part: loc.part, path: loc.path };
      } else if (payload.format === 'xlsx' && loc.kind === 'xlsx' && id(loc.sheet) && typeof loc.cell === 'string' && /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(loc.cell) && !unit.formula) {
        locator = { kind: 'xlsx', sheet: loc.sheet, cell: loc.cell };
      } else return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
      const key = JSON.stringify(locator);
      if (locators.has(key)) return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
      locators.add(key); output.push({ text: unit.text, locator });
    }
  }
  for (const [page, value] of pdf) output.push({ text: value.lines.join('\n'), locator: { kind: 'pdf', page } });
  if (output.length > 128 || output.some(unit => unit.text.length > 16_000)) return { units: [], issue: 'DOCUMENT_TEXT_INVALID' };
  return { units: output };
}

function fileIdentity(item: any): CrmControlOfferFile | null {
  const value = object(item), artifact = object(value.artifact);
  const fileUuid = typeof value.fileUuid === 'string' && UUID.test(value.fileUuid) ? value.fileUuid : null;
  const versionUuid = typeof value.versionUuid === 'string' && UUID.test(value.versionUuid) ? value.versionUuid : null;
  const sha256 = digest(artifact.sha256) && artifact.storageKey === `${artifact.sha256}.bin` ? artifact.sha256 : null;
  return (fileUuid && versionUuid) || sha256 ? { fileUuid, versionUuid, sha256 } : null;
}

function exactBudget(value: unknown): string | null {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,29})(?:\.\d{1,6})?$/.test(value)) return value;
  // A decimal JS number may already have lost precision in transport. Only exact safe integers are admitted.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

/** Read-only assessment of the immutable snapshot and its existing extraction references. */
export async function assessArchivedOffer(input: CrmControlArchivedOfferInput,
  reader?: Pick<CrmControlDocumentAnalysisService, 'read'>): Promise<CrmControlArchivedOfferAssessment> {
  const snapshot = object(input.snapshot), proposal = object(snapshot.proposalSources), browser = object(snapshot.browserSources),
    analysis = object(snapshot.documentAnalysis), deal = object(snapshot.deal);
  const issues = new Set<string>(), candidates: Candidate[] = [], cache = new Map<string, Loaded>();
  let actualSnapshotHash = '';
  try { actualSnapshotHash = createHash('sha256').update(JSON.stringify(input.snapshot)).digest('hex'); } catch { /* Fail closed below. */ }
  const scopeIssue = !id(deal.responsibleId) ? 'DEAL_OWNER_UNVERIFIED'
    : deal.id !== input.scope.dealId || deal.responsibleId !== input.scope.ownerId || actualSnapshotHash !== input.scope.snapshotHash
      ? 'SNAPSHOT_SCOPE_MISMATCH' : null;
  if (scopeIssue) {
    const validation = validateCrmControlOffer({ schemaVersion: 1, scope: input.scope, dealCreatedAt: instant(deal.createdAt), observedAt: instant(snapshot.observedAt),
      history: { scope: { ...input.scope, dealId: deal.id, ownerId: deal.responsibleId, snapshotHash: actualSnapshotHash },
        status: 'UNVERIFIED', from: instant(deal.createdAt), through: instant(snapshot.observedAt), offerClassificationComplete: false, offers: [] },
      selectedLatestOffer: null, textUnits: [], budget: { decimal: null, currency: null }, proposalField: { readComplete: false, files: [] } });
    return { validation, messages: { offer_budget: ISSUE_TEXT[scopeIssue], proposal_file: ISSUE_TEXT[scopeIssue] }, details: {
      version: 1, historyStatus: 'UNVERIFIED', issues: [scopeIssue], reasons: [ISSUE_TEXT[scopeIssue]], inspectedDocuments: 0, candidates: [] } };
  }
  const references = array(analysis.documents);
  let reads = 0, classificationComplete = true;
  const add = async (item: any, source: 'field' | 'sent', sourceId: string, sentAt: string | null) => {
    if (candidates.length >= 64) { issues.add('DOCUMENT_ANALYSIS_LIMIT'); classificationComplete = false; return; }
    const file = fileIdentity(item), sha256 = file?.sha256 ?? null;
    let loaded: Loaded;
    if (!sha256) loaded = { units: [], issue: 'DOCUMENT_NOT_ARCHIVED' };
    else if (cache.has(sha256)) loaded = cache.get(sha256)!;
    else {
      const matches = references.filter(ref => ref?.sourceSha256 === sha256);
      if (matches.length > 1) loaded = { units: [], issue: 'DOCUMENT_REFERENCE_CONFLICT' };
      else if (!reader || matches.length !== 1 || !['COMPLETE', 'UNVERIFIED'].includes(matches[0].status)
        || !digest(matches[0].outputSha256) || matches[0].storageKey !== `local-documents-v1/${sha256}.${matches[0].outputSha256}.json`) {
        loaded = { units: [], issue: 'DOCUMENT_EXTRACTION_UNAVAILABLE' };
      } else if (++reads > 32) loaded = { units: [], issue: 'DOCUMENT_ANALYSIS_LIMIT' };
      else {
        try { loaded = nativeUnits(await reader.read(matches[0] as CrmControlDocumentAnalysisReference), sha256); }
        catch { loaded = { units: [], issue: 'DOCUMENT_EXTRACTION_UNAVAILABLE' }; }
      }
      cache.set(sha256, loaded);
    }
    const textUnits: CrmControlOfferTextUnit[] = loaded.units.map((unit, index) => ({ ...unit,
      id: `document:${sha256}:${index}`, scope: { ...input.scope }, outgoingSourceId: sourceId,
      textHash: crmControlOfferTextHash(unit.text), artifactSha256: sha256, quality: 'VERIFIED_TEXT' }));
    const selection: CrmControlOfferSelection = loaded.issue ? { classification: 'UNRESOLVED', status: 'UNKNOWN', amount: null,
      headingEvidence: [], issues: [loaded.issue] } : selectCrmControlOfferCandidate({ scope: input.scope, outgoingSourceId: sourceId,
      artifactSha256: sha256!, extractionComplete: true, textUnits });
    if (source === 'sent' && (selection.classification === 'UNRESOLVED' || !sentAt)) classificationComplete = false;
    for (const code of selection.issues) issues.add(code);
    candidates.push({ source, sourceId, sentAt, artifactSha256: sha256, file, selection, textUnits });
  };
  const fieldItems = array(proposal.fieldFiles);
  const created = instant(deal.createdAt), observed = instant(snapshot.observedAt);
  const fieldFiles = fieldItems.map(fileIdentity);
  // This private bundle is constructed only from outgoing mail. Its contact binding remains unchanged.
  const fieldAnchors = anchorCrmControlOfferField({ scope: input.scope, createdAt: created, observedAt: observed, fieldFiles,
    attachments: array(browser.documents).filter(item => item?.binding === 'NOT_BOUND').slice(0, 65).map(item => ({ sourceId: `mail:${item?.threadId}:${item?.messageId}`,
      threadId: item?.threadId, messageId: item?.messageId, attachmentId: item?.attachmentId, sentAt: instant(item?.sentAt),
      direction: 'outgoing', binding: item?.binding, file: fileIdentity(item) })) });
  for (const code of fieldAnchors.issues) issues.add(code);
  for (const [index, item] of fieldItems.slice(0, 64).entries()) await add(item, 'field', `field:${index}`, null);
  if (fieldItems.length > 64) { issues.add('DOCUMENT_ANALYSIS_LIMIT'); classificationComplete = false; }
  for (const item of array(proposal.sentAttachments).slice(0, 64)) {
    if (!id(item?.messageId) || !instant(item.sentAt)) { issues.add('SENT_SOURCE_INVALID'); classificationComplete = false; continue; }
    await add(item, 'sent', `webhook:${item.messageId}`, instant(item.sentAt));
  }
  if (array(proposal.sentAttachments).length > 64) { issues.add('DOCUMENT_ANALYSIS_LIMIT'); classificationComplete = false; }
  for (const item of array(browser.documents).slice(0, 64)) {
    if (item?.binding !== 'DEAL') {
      const anchor = fieldAnchors.anchors.find(anchor => anchor.sourceId === `mail:${item?.threadId}:${item?.messageId}`
        && anchor.attachmentId === item?.attachmentId && anchor.contentAuthorized);
      if (!anchor) { issues.add('CONTACT_MAIL_NOT_BOUND'); classificationComplete = false; continue; }
      // Read the field-authorized artifact, never a contact attachment's independently supplied reference.
      const field = fieldItems[anchor.fieldIndexes[0]];
      await add(field, 'sent', anchor.sourceId, anchor.sentAt);
      continue;
    }
    if (!id(item.threadId) || !id(item.messageId) || !instant(item.sentAt)) { issues.add('SENT_SOURCE_INVALID'); classificationComplete = false; continue; }
    await add(item, 'sent', `mail:${item.threadId}:${item.messageId}`, instant(item.sentAt));
  }
  if (array(browser.documents).length > 64) { issues.add('DOCUMENT_ANALYSIS_LIMIT'); classificationComplete = false; }
  const trusted = input.trustedHistory && Array.isArray(input.trustedHistory.offers) && input.trustedHistory.offers.length <= 4096 ? input.trustedHistory : undefined;
  if (input.trustedHistory && !trusted) issues.add('INVALID_TRUSTED_HISTORY');
  const history: CrmControlOfferValidationInput['history'] = trusted ? { ...trusted, offers: [...trusted.offers],
    offerClassificationComplete: trusted.offerClassificationComplete && classificationComplete } : {
    scope: { ...input.scope }, status: 'UNVERIFIED', from: created, through: observed, offerClassificationComplete: false, offers: [],
  };
  const sent = candidates.filter(candidate => candidate.source === 'sent' && candidate.selection.classification === 'OFFER');
  if (!sent.length) issues.add('NO_ARCHIVED_SENT_OFFER');
  if (trusted?.status === 'VERIFIED_COMPLETE') for (const candidate of sent) {
    const matches = trusted.offers.filter(event => event.sourceId === candidate.sourceId && Date.parse(event.sentAt) === Date.parse(candidate.sentAt!));
    if (matches.length !== 1 || !array(matches[0].files).some(file => file?.sha256 && file.sha256 === candidate.artifactSha256)) {
      history.status = 'UNVERIFIED'; issues.add('SENT_HISTORY_CONFLICT');
    }
  }
  if (history.status !== 'VERIFIED_COMPLETE' || !history.offerClassificationComplete) issues.add('INCOMPLETE_SENT_HISTORY');
  let latestSourceId: string | null = null;
  const ordered = trusted ? [...trusted.offers].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
    : sent.map(item => ({ sourceId: item.sourceId, sentAt: item.sentAt! })).sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  if (ordered.length) latestSourceId = ordered[0].sourceId;
  const latestCandidates = new Map<string, Candidate>();
  for (const candidate of sent.filter(item => item.sourceId === latestSourceId)) if (candidate.artifactSha256) latestCandidates.set(candidate.artifactSha256, candidate);
  if (latestCandidates.size > 1) issues.add('MULTIPLE_PROPOSALS_IN_MESSAGE');
  const selected = latestCandidates.size === 1 ? [...latestCandidates.values()][0] : null;
  const fieldComplete = proposal.fieldReadComplete === true && Array.isArray(proposal.fieldFiles) && fieldFiles.every(file => file !== null) && fieldItems.length <= 64;
  if (!fieldComplete) issues.add('PROPOSAL_FIELD_INCOMPLETE');
  const validation = validateCrmControlOffer({ schemaVersion: 1, scope: input.scope, dealCreatedAt: created, observedAt: observed,
    history, selectedLatestOffer: latestSourceId ? { scope: input.scope, sourceId: latestSourceId,
      amount: selected?.selection.amount ?? null, proposalFile: selected?.file ?? null } : null,
    textUnits: selected?.textUnits ?? [], budget: { decimal: exactBudget(deal.amount), currency: typeof snapshot.currency === 'string' ? snapshot.currency : null },
    proposalField: { readComplete: fieldComplete, files: fieldFiles.filter((file): file is CrmControlOfferFile => file !== null) } });
  for (const rule of [validation.offerBudget, validation.proposalFile]) for (const code of rule.issues) issues.add(code);
  const message = (kind: 'offerBudget' | 'proposalFile') => {
    const rule = validation[kind];
    if (rule.status === 'PASS') return kind === 'offerBudget' ? 'Бюджет совпадает с подтверждённым итогом последнего отправленного КП.' : 'В поле «КП» только последняя отправленная версия.';
    if (rule.status === 'FAIL') return kind === 'offerBudget' ? 'Бюджет не совпадает с итогом последнего отправленного КП.'
      : rule.issues.includes('LATEST_PROPOSAL_MISSING') ? 'В поле «КП» нет последней отправленной версии.' : 'В поле «КП» есть лишний файл или старая версия.';
    if (rule.status === 'NA') return 'В полной подтверждённой истории ещё нет отправленного предложения.';
    const primary = rule.issues.map(code => ISSUE_TEXT[code]).find(Boolean);
    const context = [...issues].filter(code => !rule.issues.includes(code) && code !== 'INCOMPLETE_SENT_HISTORY').map(code => ISSUE_TEXT[code]).filter(Boolean).slice(0, 2);
    return [primary || 'Недостаточно подтверждений для сравнения.', ...context].join(' ');
  };
  return { validation, messages: { offer_budget: message('offerBudget'), proposal_file: message('proposalFile') }, details: {
    version: 1, historyStatus: history.status, issues: [...issues], reasons: [
      ...(fieldAnchors.anchors.some(anchor => anchor.contentAuthorized) ? ['Закреплённый файл найден среди отправленных вложений. Совпадение содержимого подтверждено. Остаётся проверить, не отправлялось ли более новое КП.'] : []),
      ...new Set([...issues].map(code => ISSUE_TEXT[code]).filter(Boolean))], fieldAnchors: fieldAnchors.anchors,
    inspectedDocuments: Math.min(reads, 32), candidates: candidates.map(candidate => ({ status: 'CANDIDATE_ONLY', source: candidate.source,
      sourceId: candidate.sourceId, sentAt: candidate.sentAt, artifactSha256: candidate.artifactSha256,
      classification: candidate.selection.classification, selectionStatus: candidate.selection.status, issues: candidate.selection.issues,
      headingEvidence: candidate.selection.headingEvidence.slice(0, 1), amount: candidate.selection.amount ? {
        decimal: candidate.selection.amount.decimal, currency: candidate.selection.amount.currency,
        evidence: [candidate.selection.amount.amountCitation, candidate.selection.amount.currencyCitation] } : null })) } };
}
