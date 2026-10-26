import {PlatformService} from './platform.service';
describe('Telegram report values and Moscow delivery time',()=>{
  const service=Object.create(PlatformService.prototype) as any;
  it.each([
    ['2026-10-23T05:00:00Z','09:00','2026-10-23T06:00:00.000Z'],
    ['2026-10-23T07:00:00Z','09:00','2026-10-24T06:00:00.000Z'],
    ['2026-10-23T20:30:00Z','00:00','2026-10-23T21:00:00.000Z'],
  ])('schedules %s at %s Moscow, independent of host timezone', (from,time,expected)=>{
    expect(service.nextScheduleRun('DAILY',time,new Date(from)).toISOString()).toBe(expected);
  });
  it('does not turn an unavailable report value into zero',()=>{
    expect(service.extractAlertValue({summaryRows:[{metrics:{paid:{value:null}}}]},'summaryRows.0.metrics.paid.value')).toBeNull();
    expect(service.extractAlertValue({summaryRows:[{metrics:{paid:{value:0}}}]},'summaryRows.0.metrics.paid.value')).toBe(0);
  });
  it('uses the explicitly selected total, not the first manager value',()=>{
    expect(service.extractAlertValue({summaryRows:[{metrics:{paid:{value:12}}}],rows:[{metrics:{paid:{value:3}}}]},'summaryRows.0.metrics.paid.value')).toBe(12);
  });
  it('includes canonical totals and EUR in a funnel notification',()=>{
    const text=service.reportTelegramMessage('Продажи',{summaryRows:[{metrics:{amount:{label:'Сумма оплат',value:1500,unit:'money'}}}]});
    expect(text).toContain('Сумма оплат:');expect(text).toContain('€');expect(text).not.toContain('₽');
  });
  it('includes forecast revenue and profit rather than only deal count',()=>{
    const text=service.reportTelegramMessage('Прогноз',{summary:{count:2,revenue:1500,profit:300}});
    expect(text).toContain('Прогноз выручки: 1');expect(text).toContain('Прогноз прибыли: 300 €');
  });
});
