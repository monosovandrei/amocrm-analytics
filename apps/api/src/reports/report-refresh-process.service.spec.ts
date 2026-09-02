import { ReportRefreshProcessService } from './report-refresh-process.service';

describe('ReportRefreshProcessService', () => {
  it('runs every report in a separate process', async () => {
    const service = new ReportRefreshProcessService() as any;
    service.runOne = jest
      .fn()
      .mockResolvedValueOnce({ processed: 1 })
      .mockResolvedValueOnce({ processed: 1 })
      .mockResolvedValueOnce({ processed: 1 });

    await expect(service.process(3)).resolves.toEqual({ processed: 3 });
    expect(service.runOne).toHaveBeenCalledTimes(3);
  });

  it('stops spawning processes when the queue is empty', async () => {
    const service = new ReportRefreshProcessService() as any;
    service.runOne = jest.fn().mockResolvedValueOnce({ processed: 1 }).mockResolvedValueOnce({ processed: 0 });

    await expect(service.process(4)).resolves.toEqual({ processed: 1 });
    expect(service.runOne).toHaveBeenCalledTimes(2);
  });
});
