import { createHash } from 'node:crypto';
import type { CrmControlSemanticRequest } from './crm-control-semantic.validation';

/** JSONB does not preserve object key order. Array order remains part of the source identity. */
export function canonicalCrmControlSemanticJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCrmControlSemanticJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalCrmControlSemanticJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Keep the original enqueue wrapper order so already archived request hashes remain valid. */
export function crmControlSemanticInputHash(input: CrmControlSemanticRequest,
  identity: { promptVersion: string; model: string; modelSha256: string }): string {
  return createHash('sha256').update(JSON.stringify({ promptVersion: identity.promptVersion,
    model: identity.model, modelSha256: identity.modelSha256,
    input: JSON.parse(canonicalCrmControlSemanticJson(input)) })).digest('hex');
}
