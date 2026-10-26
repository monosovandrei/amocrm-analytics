import {TelegramService} from './telegram.service';
import {TelegramPausedError,TELEGRAM_SEND_LOCK} from './telegram-configuration';

describe('Telegram global pause',()=>{
  let fetchMock:jest.SpyInstance;
  beforeEach(()=>{fetchMock=jest.spyOn(global,'fetch').mockResolvedValue({ok:true,json:async()=>({ok:true})} as any);});
  afterEach(()=>fetchMock.mockRestore());
  function fixture(enabled:boolean|null){
    const tx={$queryRaw:jest.fn().mockResolvedValue([]),telegramSettings:{findUnique:jest.fn().mockResolvedValue(enabled===null?null:{enabled})}};
    const db={$transaction:jest.fn(fn=>fn(tx)),telegramAccount:{findUnique:jest.fn().mockResolvedValue({id:'account',isActive:true,chatId:'synthetic-chat'})},notificationDelivery:{findUnique:jest.fn().mockResolvedValue(null),create:jest.fn(input=>Promise.resolve(input.data))}};
    return {service:new TelegramService(db as any,{get:()=> 'synthetic-test-token'} as any),tx,db};
  }
  it.each([false,null])('does not contact Telegram if enabled=%s',async enabled=>{
    const {service,tx}=fixture(enabled);
    await expect(service.sendChatMessage('synthetic-chat','message')).rejects.toBeInstanceOf(TelegramPausedError);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(TELEGRAM_SEND_LOCK);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('records a paused notification as SKIPPED, never SENT or ERROR',async()=>{
    const {service}=fixture(false);
    const result=await service.sendDirectMessageToCrmUser('manager','message');
    expect(result.status).toBe('SKIPPED');expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails closed when the settings database is unavailable',async()=>{
    const {service,tx}=fixture(true);tx.telegramSettings.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(service.sendChatMessage('synthetic-chat','message')).rejects.toThrow('database unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sends only after acquiring the shared pause lock and checking enabled',async()=>{
    const {service,tx}=fixture(true);await service.sendChatMessage('synthetic-chat','message');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.telegramSettings.findUnique.mock.invocationCallOrder[0]);
    expect(tx.telegramSettings.findUnique.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });
});
