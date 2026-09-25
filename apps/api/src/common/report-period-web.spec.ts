import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('report periods match the Moscow business calendar', () => {
  it('uses identical preset bounds and requests across five browser timezones', () => {
    const script = resolve(__dirname, '../../../..', 'scripts/test-report-periods.cjs');
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout).status).toBe('passed');
  });
});
