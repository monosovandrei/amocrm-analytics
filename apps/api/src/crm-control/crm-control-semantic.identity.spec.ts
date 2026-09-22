import { createHash } from 'node:crypto';
import { canonicalCrmControlSemanticJson, crmControlSemanticInputHash } from './crm-control-semantic.identity';
import type { CrmControlSemanticRequest } from './crm-control-semantic.validation';

const identity = { promptVersion: '4', model: 'synthetic-model', modelSha256: 'a'.repeat(64) };
const input = { check: 'proposal_note', sources: [{ id: 'first', text: 'Первый источник' }, { id: 'second', text: 'Второй источник' }],
  coverage: { tasks: true, notes: true, communications: false }, ownerId: 'manager', dealId: 'deal' } as CrmControlSemanticRequest;
function reverseKeys(value: any): any {
  return Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
}

describe('archived semantic request identity', () => {
  it('preserves the pre-fix enqueue hash format, including the outer wrapper order', () => {
    const archived = JSON.parse(canonicalCrmControlSemanticJson(input));
    const previous = createHash('sha256').update(JSON.stringify({ promptVersion: identity.promptVersion,
      model: identity.model, modelSha256: identity.modelSha256, input: archived })).digest('hex');
    expect(crmControlSemanticInputHash(input, identity)).toBe(previous);
  });
  it('ignores nested object key order and omitted optional keys, including JSONB roundtrip ordering', () => {
    expect(crmControlSemanticInputHash(reverseKeys(input), identity)).toBe(crmControlSemanticInputHash(input, identity));
    expect(crmControlSemanticInputHash({ ...input, taskDueAt: undefined }, identity)).toBe(crmControlSemanticInputHash(input, identity));
  });
  it.each(['sourceText', 'sourceOrder', 'ownerId', 'dealId', 'promptVersion', 'model', 'modelSha256'])('changes identity when %s changes', field => {
    const changed = structuredClone(input), metadata = { ...identity };
    if (field === 'sourceText') changed.sources[0].text = 'Изменённый источник';
    else if (field === 'sourceOrder') changed.sources.reverse();
    else if (field === 'ownerId' || field === 'dealId') changed[field] = 'other';
    else metadata[field as keyof typeof metadata] = 'changed';
    expect(crmControlSemanticInputHash(changed, metadata)).not.toBe(crmControlSemanticInputHash(input, identity));
  });
});
