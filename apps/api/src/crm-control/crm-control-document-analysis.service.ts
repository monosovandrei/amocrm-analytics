import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { CrmBrowserSourceBundle } from './crm-control-browser-source.service';
import { crmControlDocumentDirectory, readCrmControlPrivateArtifact } from './crm-control-document-evidence';
import { CrmControlDocumentPayload, CrmControlLocalExtractionClient } from './crm-control-local-extraction.client';
import { CrmControlDocumentArtifact, CrmControlProposalSources } from './crm-control-proposal-sources';

export interface CrmControlDocumentAnalysisReference {
  sourceSha256: string; status: 'COMPLETE' | 'UNVERIFIED' | 'ERROR'; issues: string[];
  outputSha256?: string; storageKey?: string;
}
export interface CrmControlDocumentAnalysis { version: 1; documents: CrmControlDocumentAnalysisReference[]; }
const HASH = /^[a-f0-9]{64}$/;
const EXTRACTOR = 'local-documents-v1';

@Injectable()
export class CrmControlDocumentAnalysisService {
  private tail: Promise<void> = Promise.resolve();
  private client: CrmControlLocalExtractionClient | null = null;
  private clientIdentity = '';

  private options() {
    const directory = crmControlDocumentDirectory(), scripts = process.env.CRM_CONTROL_LOCAL_SCRIPTS_DIR,
      python = process.env.CRM_CONTROL_PYTHON;
    if (!directory || !scripts || !path.isAbsolute(scripts) || !python || !path.isAbsolute(python)) return null;
    return { documentDirectory: directory, recordingDirectory: directory, scriptsDirectory: scripts, pythonPath: python };
  }

  /** Sequential, bounded per deal. The content-addressed Python cache survives worker restarts. */
  collect(proposal: CrmControlProposalSources, browser: CrmBrowserSourceBundle | null): Promise<CrmControlDocumentAnalysis> {
    const execute = async () => {
      const options = this.options();
      const artifacts = new Map<string, CrmControlDocumentArtifact>();
      for (const item of [...proposal.fieldFiles, ...proposal.sentAttachments, ...(browser?.documents.filter(item => item.binding === 'DEAL') ?? [])]) {
        if (item.artifact && HASH.test(item.artifact.sha256) && item.artifact.storageKey === `${item.artifact.sha256}.bin`) artifacts.set(item.artifact.sha256, item.artifact);
      }
      const output: CrmControlDocumentAnalysis = { version: 1, documents: [] };
      if (options && this.clientIdentity !== JSON.stringify(options)) { this.client = new CrmControlLocalExtractionClient(options); this.clientIdentity = JSON.stringify(options); }
      const signal = AbortSignal.timeout(120_000);
      let count = 0;
      for (const artifact of artifacts.values()) {
        const item: CrmControlDocumentAnalysisReference = { sourceSha256: artifact.sha256, status: 'ERROR', issues: [] };
        output.documents.push(item);
        if (!options || !this.client) { item.issues.push('LOCAL_EXTRACTION_NOT_CONFIGURED'); continue; }
        if (++count > 32 || signal.aborted) { item.issues.push('DOCUMENT_ANALYSIS_LIMIT'); continue; }
        const result = await this.client.extract({ filePath: path.join(options.documentDirectory, artifact.storageKey),
          sha256: artifact.sha256, mimeType: artifact.contentType?.split(';')[0].trim() || null }, signal);
        if (result.status === 'ERROR') { item.issues.push(result.code); continue; }
        item.status = result.payload.status; item.issues = result.payload.problems;
        item.outputSha256 = result.outputSha256;
        item.storageKey = `${EXTRACTOR}/${path.basename(result.outputPath)}`;
      }
      return output;
    };
    const result = this.tail.then(execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Internal only. A public request cannot choose an extraction path. */
  async read(reference: CrmControlDocumentAnalysisReference): Promise<CrmControlDocumentPayload> {
    const root = crmControlDocumentDirectory();
    const expected = `${EXTRACTOR}/${reference.sourceSha256}.${reference.outputSha256}.json`;
    if (!root || !HASH.test(reference.sourceSha256) || !reference.outputSha256 || !HASH.test(reference.outputSha256)
      || reference.storageKey !== expected) throw new Error('DOCUMENT_ANALYSIS_INVALID');
    const bytes = await readCrmControlPrivateArtifact(root, `.extracted/${reference.storageKey}`, reference.outputSha256, 16 * 1024 * 1024);
    const payload = JSON.parse(bytes.toString('utf8')) as CrmControlDocumentPayload;
    if (payload.sourceSha256 !== reference.sourceSha256 || payload.extractorVersion !== EXTRACTOR || payload.status !== reference.status
      || !Array.isArray(payload.units) || payload.units.length > 50_000 || !Array.isArray(payload.problems)) throw new Error('DOCUMENT_ANALYSIS_INVALID');
    return payload;
  }
}
