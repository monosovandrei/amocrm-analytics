import {TelegramAdminController} from './telegram-admin.controller';
import {ConflictException,ForbiddenException} from '@nestjs/common';
import {TELEGRAM_SEND_LOCK} from './telegram-configuration';

describe('Telegram administrator settings',()=>{
  function fixture(){
    const tx={$queryRaw:jest.fn().mockResolvedValue([]),telegramSettings:{findUniqueOrThrow:jest.fn().mockResolvedValue({version:3,enabled:false}),update:jest.fn().mockResolvedValue({version:4,enabled:false})},notificationTemplate:{updateMany:jest.fn().mockResolvedValue({count:1}),findUniqueOrThrow:jest.fn().mockResolvedValue({id:'rule'})},auditLog:{create:jest.fn()}};
    const db={user:{findUnique:jest.fn().mockResolvedValue({id:'admin',isActive:true,role:'ADMIN',businessRole:'MANAGER'}),count:jest.fn().mockResolvedValue(0)},notificationTemplate:{findUniqueOrThrow:jest.fn().mockResolvedValue({id:'rule',version:2,isActive:false})},$transaction:jest.fn(fn=>fn(tx))};
    return {controller:new TelegramAdminController(db as any,{} as any,{} as any),db,tx};
  }
  const body={version:3,enabled:false,parameters:{},quality:{enabled:false,recipientIds:[],repeatMinutes:30,includeRecovery:true}};
  it.each(['ROP','MANAGER'])('denies %s even if the caller claims to be an administrator',async role=>{
    const {controller,db}=fixture();db.user.findUnique.mockResolvedValue({id:'admin',isActive:true,role:'ROP',businessRole:role} as any);
    await expect(controller.pause({user:{id:'admin',role:'ADMIN'}})).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects disabled administrators',async()=>{
    const {controller,db}=fixture();db.user.findUnique.mockResolvedValue({id:'admin',isActive:false,role:'ADMIN'} as any);
    await expect(controller.pause({user:{id:'admin'}})).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('always permits emergency pause without validating unfinished rule drafts',async()=>{
    const {controller,tx}=fixture();await controller.pause({user:{id:'admin'}});
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(TELEGRAM_SEND_LOCK);
    expect(tx.telegramSettings.update).toHaveBeenCalledWith({where:{id:'default'},data:{enabled:false,version:{increment:1}}});
    expect(tx.auditLog.create).toHaveBeenCalled();
  });
  it('rejects concurrent changes instead of silently overwriting settings',async()=>{
    const {controller}=fixture();await expect(controller.settings({user:{id:'admin'}},{...body,version:1})).rejects.toBeInstanceOf(ConflictException);
  });
  it('does not enable general sending when a rule is saved',async()=>{
    const {controller,tx}=fixture();await controller.rule({user:{id:'admin'}},'amo_new_assigned_lead',{version:2,isActive:true,body:'{manager}, новый лид {dealUrl}',deliveryMode:'direct_responsible'});
    expect(tx.notificationTemplate.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{id:'rule',version:2},data:expect.objectContaining({isActive:true,enabledAt:expect.any(Date)})}));
    expect(tx.telegramSettings.update).not.toHaveBeenCalled();
  });
  it('rejects unknown message variables and out-of-range thresholds',async()=>{
    const {controller,db}=fixture();await expect(controller.rule({user:{id:'admin'}},'amo_new_assigned_lead',{version:2,isActive:true,body:'{nonexistent}',deliveryMode:'direct_responsible'})).rejects.toThrow('Неизвестные вставки');
    await expect(controller.settings({user:{id:'admin'}},{...body,parameters:{csmDailyCheckHour:27}})).rejects.toThrow('Проверьте');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects an active rule without a delivery destination',async()=>{
    const {controller}=fixture();await expect(controller.rule({user:{id:'admin'}},'amo_new_assigned_lead',{version:2,isActive:true,body:'Сообщение',deliveryMode:'disabled'})).rejects.toThrow('выберите получателей');
  });
});
