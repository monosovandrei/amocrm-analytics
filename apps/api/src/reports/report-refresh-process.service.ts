import { Injectable } from '@nestjs/common';
import { fork } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_REPORT_REFRESH_PROCESS_TIMEOUT_MS = 5 * 60_000;
const MIN_REPORT_REFRESH_PROCESS_TIMEOUT_MS = 30_000;
const MAX_REPORT_REFRESH_PROCESS_TIMEOUT_MS = 30 * 60_000;

type ReportRefreshResult = { processed: number };

@Injectable()
export class ReportRefreshProcessService {
  async process(limit: number): Promise<ReportRefreshResult> {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    let processed = 0;

    for (let index = 0; index < normalizedLimit; index += 1) {
      const result = await this.runOne();
      processed += result.processed;
      if (result.processed === 0) break;
    }

    return { processed };
  }

  private runOne(): Promise<ReportRefreshResult> {
    return new Promise((resolve, reject) => {
      const child = fork(join(__dirname, 'report-refresh-runner.js'), [], {
        env: { ...process.env, WORKER_ROLE: 'report-refresh-runner' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let childResult: ReportRefreshResult | null = null;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(childResult ?? { processed: 0 });
      };

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
        forceKill.unref();
        finish(new Error(`Report refresh process exceeded ${this.resolveTimeoutMs()}ms`));
      }, this.resolveTimeoutMs());
      timeout.unref();

      child.on('message', (message: unknown) => {
        if (!this.isResult(message)) return;
        childResult = message;
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        if (code === 0 && childResult) {
          finish();
          return;
        }
        finish(new Error(`Report refresh process exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`));
      });
    });
  }

  private isResult(message: unknown): message is ReportRefreshResult {
    if (!message || typeof message !== 'object') return false;
    const processed = (message as ReportRefreshResult).processed;
    return Number.isInteger(processed) && processed >= 0;
  }

  private resolveTimeoutMs() {
    const value = Number(process.env.REPORT_REFRESH_PROCESS_TIMEOUT_MS);
    if (!Number.isFinite(value)) return DEFAULT_REPORT_REFRESH_PROCESS_TIMEOUT_MS;
    return Math.min(MAX_REPORT_REFRESH_PROCESS_TIMEOUT_MS, Math.max(MIN_REPORT_REFRESH_PROCESS_TIMEOUT_MS, Math.floor(value)));
  }
}
