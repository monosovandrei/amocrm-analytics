import { CrmEventNotificationsService } from './crm-event-notifications.service';

describe('CrmEventNotificationsService payment notification routing', () => {
  function createService() {
    const prisma = {
      crmUser: {
        findMany: jest.fn(),
      },
    };
    const telegram = {
      sendDirectMessageToCrmUsers: jest.fn().mockResolvedValue([{ status: 'SENT' }]),
    };
    const service = new CrmEventNotificationsService(prisma as any, telegram as any);
    return { service: service as any, prisma, telegram };
  }

  it('routes Sales pipeline payments to Stepan', async () => {
    const { service, prisma, telegram } = createService();
    prisma.crmUser.findMany.mockResolvedValue([{ id: 'stepan-crm-user-id' }]);

    await service.sendPaymentNotificationByPipeline(
      {
        id: 'stage-sales-paid',
        externalId: '142',
        name: '\u0421\u0427\u0415\u0422 \u041e\u041f\u041b\u0410\u0427\u0415\u041d',
        pipeline: { externalId: '1278508', name: '\u0412\u043e\u0440\u043e\u043d\u043a\u0430 \u041f\u0440\u043e\u0434\u0430\u0436\u0438' },
      },
      'message',
      { type: 'amo_payment_received' },
      'event-key',
    );

    expect(prisma.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        externalId: { in: ['13930346'] },
      }),
    }));
    expect(telegram.sendDirectMessageToCrmUsers).toHaveBeenCalledWith(
      ['stepan-crm-user-id'],
      'message',
      expect.objectContaining({ paymentPipeline: '\u0412\u043e\u0440\u043e\u043d\u043a\u0430 \u041f\u0440\u043e\u0434\u0430\u0436\u0438' }),
      undefined,
      'event-key:payment-route',
    );
  });

  it.each([
    '\u0411\u0430\u0437\u0430',
    '\u0417\u0430\u043a\u0440\u0435\u043f\u043b\u0435\u043d\u043d\u044b\u0435 \u041a\u043e\u043c\u043f\u0430\u043d\u0438\u0438',
  ])('routes %s pipeline payments to Serafima', async (pipelineName) => {
    const { service, prisma, telegram } = createService();
    prisma.crmUser.findMany.mockResolvedValue([{ id: 'serafima-crm-user-id' }]);

    await service.sendPaymentNotificationByPipeline(
      {
        id: 'stage-csm-paid',
        externalId: '142',
        name: '\u0421\u0447\u0435\u0442 \u043e\u043f\u043b\u0430\u0447\u0435\u043d',
        pipeline: { externalId: '8032322', name: pipelineName },
      },
      'message',
      { type: 'amo_payment_received' },
      'event-key',
    );

    expect(prisma.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        externalId: { in: ['7462243'] },
      }),
    }));
    expect(telegram.sendDirectMessageToCrmUsers).toHaveBeenCalledWith(
      ['serafima-crm-user-id'],
      'message',
      expect.objectContaining({ paymentPipeline: pipelineName }),
      undefined,
      'event-key:payment-route',
    );
  });

  it('leaves unmatched pipelines to fallback logic', async () => {
    const { service, prisma, telegram } = createService();

    const result = await service.sendPaymentNotificationByPipeline(
      {
        id: 'stage-other-paid',
        externalId: '142',
        name: 'WON',
        pipeline: { externalId: '10993426', name: 'ABM' },
      },
      'message',
      { type: 'amo_payment_received' },
      'event-key',
    );

    expect(result).toBeNull();
    expect(prisma.crmUser.findMany).not.toHaveBeenCalled();
    expect(telegram.sendDirectMessageToCrmUsers).not.toHaveBeenCalled();
  });
});
