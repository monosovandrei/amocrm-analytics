import { CrmEventNotificationsService } from './crm-event-notifications.service';

describe('CrmEventNotificationsService payment notification routing', () => {
  it('restricts selected managers to their own deals and department heads to their department',async()=>{
    const prisma={user:{findUnique:jest.fn()},crmUser:{findUnique:jest.fn()}};
    const service=new CrmEventNotificationsService(prisma as any,{} as any) as any;
    prisma.user.findUnique.mockResolvedValue({isActive:true,businessRole:'MANAGER',crmUserId:'manager-one'});
    expect(await service.recipientMaySeeNotification({kind:'platform_user',id:'user'},{managerCrmUserId:'manager-one'})).toBe(true);
    expect(await service.recipientMaySeeNotification({kind:'platform_user',id:'user'},{managerCrmUserId:'manager-two'})).toBe(false);
    prisma.user.findUnique.mockResolvedValue({isActive:true,businessRole:'ROP',departmentKey:'sales'});
    expect(await service.recipientMaySeeNotification({kind:'platform_user',id:'head'},{team:'sales'})).toBe(true);
    expect(await service.recipientMaySeeNotification({kind:'platform_user',id:'head'},{team:'csm'})).toBe(false);
  });
  it('routes ROP notifications by the assigned department rather than the Support group',()=>{
    const service=new CrmEventNotificationsService({} as any,{} as any) as any;
    const users=[{id:'sales-head',businessRole:'ROP',departmentKey:'sales',crmUser:{group:{name:'Support, Management'}}},{id:'cs-head',businessRole:'ROP',departmentKey:'csm',crmUser:{group:{name:'Support, Management'}}},{id:'unconfigured',businessRole:'ROP',departmentKey:null,crmUser:{group:{name:'Sales'}}}];
    expect(service.salesLeaderUsers(users).map((u:any)=>u.id)).toEqual(['sales-head']);expect(service.csmLeaderUsers(users).map((u:any)=>u.id)).toEqual(['cs-head']);
  });
  function createService() {
    const prisma = {
      workspaceDepartment:{findFirst:jest.fn()},
      user:{findMany:jest.fn()},
      crmUser: {
        findMany: jest.fn(),
      },
      notificationTemplate: {
        findUnique: jest.fn(),
      },
    };
    const telegram = {
      sendDirectMessageToUsers:jest.fn().mockResolvedValue([{status:'SENT'}]),
      sendMessageToSelectedGroups:jest.fn().mockResolvedValue([{status:'SENT'}]),
      sendDirectMessageToCrmUsers: jest.fn().mockResolvedValue([{ status: 'SENT' }]),
      sendDirectMessageToCrmUser: jest.fn().mockResolvedValue({ status: 'SENT' }),
      sendDirectMessageToUser: jest.fn().mockResolvedValue({ status: 'SENT' }),
      sendMessageToGroups: jest.fn().mockResolvedValue([{ status: 'SENT' }]),
      sendDirectMessageToAllConnected: jest.fn().mockResolvedValue([{ status: 'SENT' }]),
    };
    const service = new CrmEventNotificationsService(prisma as any, telegram as any);
    return { service: service as any, prisma, telegram };
  }

  it.each(['sales','csm'])('routes %s payments to current department heads, without fixed CRM IDs', async departmentKey => {
    const {service,prisma,telegram}=createService();
    prisma.workspaceDepartment.findFirst.mockResolvedValue({key:departmentKey});
    prisma.user.findMany.mockResolvedValue([{id:'current-head-one'},{id:'current-head-two'}]);
    await service.sendPaymentNotificationByPipeline({id:'paid-stage',pipeline:{name:'renamed CRM pipeline'}},'message',{},'event');
    expect(prisma.workspaceDepartment.findFirst).toHaveBeenCalledWith({where:{paymentStageIds:{has:'paid-stage'}},select:{key:true}});
    expect(prisma.user.findMany).toHaveBeenCalledWith({where:{isActive:true,businessRole:'ROP',departmentKey},select:{id:true}});
    expect(telegram.sendDirectMessageToUsers).toHaveBeenCalledWith(['current-head-one','current-head-two'],'message',{},undefined,'event:department-heads');
    expect(prisma.crmUser.findMany).not.toHaveBeenCalled();
  });
  it('does not route an unknown payment stage to arbitrary people',async()=>{
    const {service,prisma,telegram}=createService();
    prisma.workspaceDepartment.findFirst.mockResolvedValue(null);
    expect(await service.sendPaymentNotificationByPipeline({id:'unknown'},'message',{},'event')).toEqual([]);
    expect(telegram.sendDirectMessageToUsers).not.toHaveBeenCalled();
  });

  it('ignores manual recipients for personal manager events', async () => {
    const { service, prisma, telegram } = createService();
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      recipients: [{ kind: 'crm_user', id: 'other-manager-id' }],
    });

    const result = await service.sendConfiguredNotification(
      'amo_new_assigned_lead',
      'message',
      { managerCrmUserId: 'responsible-manager-id' },
      'event-key',
    );

    expect(result).toBeNull();
    expect(telegram.sendDirectMessageToCrmUser).not.toHaveBeenCalled();
    expect(telegram.sendDirectMessageToUser).not.toHaveBeenCalled();
    expect(telegram.sendMessageToGroups).not.toHaveBeenCalled();
  });

  it('sends direct-responsible mode only to the responsible CRM user', async () => {
    const { service, prisma, telegram } = createService();
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      recipients: [{ kind: 'delivery_mode', id: 'direct_responsible' }],
    });

    await service.sendConfiguredNotification(
      'amo_payment_received',
      'message',
      { managerCrmUserId: 'responsible-manager-id' },
      'event-key',
    );

    expect(telegram.sendDirectMessageToCrmUser).toHaveBeenCalledWith(
      'responsible-manager-id',
      'message',
      expect.objectContaining({ deliveryMode: 'direct_responsible' }),
      undefined,
      'event-key:direct-responsible',
    );
    expect(telegram.sendMessageToGroups).not.toHaveBeenCalled();
  });

  it('sends group mode only to explicitly selected Telegram groups', async () => {
    const { service, prisma, telegram } = createService();
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      recipients: [{ kind: 'delivery_mode', id: 'group' }],groupIds:['chosen-group'],
    });

    await service.sendConfiguredNotification(
      'amo_deal_mass_move',
      'message',
      {},
      'event-key',
    );

    expect(telegram.sendMessageToSelectedGroups).toHaveBeenCalledWith(
      ['chosen-group'],
      'message',
      expect.objectContaining({ deliveryMode: 'group' }),
      'event-key:telegram-group',
    );
    expect(telegram.sendDirectMessageToCrmUser).not.toHaveBeenCalled();
  });

  it('treats prepared proposals as overdue after two Moscow working days', () => {
    const { service } = createService();
    const enteredAt = new Date('2026-08-14T09:00:00.000Z'); // Friday, 12:00 MSK

    expect(service.isPreparedProposalStage('КП подготовлено')).toBe(true);
    expect(service.isProposalOrObjectionStage('КП подготовлено')).toBe(false);
    expect(service.preparedProposalIsStale(enteredAt, new Date('2026-08-17T20:59:59.000Z'))).toBe(false);
    expect(service.preparedProposalIsStale(enteredAt, new Date('2026-08-18T09:00:00.000Z'))).toBe(true);
  });
});
