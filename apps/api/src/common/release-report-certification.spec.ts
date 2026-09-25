import { resolve } from 'path';

const { waitForCertification } = require(resolve(__dirname, '../../../../scripts/prepare-release-reports.cjs'));

describe('release report certification gate', () => {
  it('waits for this release, not the previous certificate or a pending source check', async () => {
    const quality = { status: jest.fn()
      .mockResolvedValueOnce({ overall: 'CERTIFIED', buildId: 'old', metricVersion: 'v1' })
      .mockResolvedValueOnce({ overall: 'CHECKING', buildId: 'new', metricVersion: 'v2' })
      .mockResolvedValue({ overall: 'CERTIFIED', buildId: 'new', metricVersion: 'v2' }) };
    let time = 0;
    const sleep = jest.fn(async (ms) => { time += ms; });
    await waitForCertification(quality, 'new', 'v2', { now: () => time, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed on persistent bad data', async () => {
    const quality = { status: jest.fn().mockResolvedValue({ overall: 'BLOCKED', buildId: 'new', metricVersion: 'v2' }) };
    let time = 0;
    await expect(waitForCertification(quality, 'new', 'v2', {
      now: () => time, sleep: async (ms: number) => { time += ms; }, timeoutMs: 2000,
    })).rejects.toThrow('did not become certified');
  });
});
