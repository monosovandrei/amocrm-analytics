export const TELEGRAM_SEND_LOCK = 826401231;
export class TelegramPausedError extends Error {
  constructor() { super('Все Telegram-отправки приостановлены администратором'); }
}
export const TELEGRAM_PARAMETERS = [
  {key:'workSlaMinutes',label:'Входящий лид: срок взятия в работу, рабочих минут',value:20,min:1,max:1440},
  {key:'assignedLeadReminderMinutes',label:'Повторное напоминание о назначенном лиде, рабочих минут',value:10,min:1,max:1440},
  {key:'offHoursFirstPingHour',label:'Лид вне рабочего времени: час первого сообщения МСК',value:10,min:0,max:23},
  {key:'offHoursFirstPingMinute',label:'Минута первого сообщения МСК',value:30,min:0,max:59},
  {key:'massTaskMoveThreshold',label:'Массовые изменения: минимум задач или сделок (продажи и CS)',value:5,min:2,max:10000},
  {key:'massTaskMoveWindowMinutes',label:'Окно массовых изменений, минут',value:15,min:1,max:1440},
  {key:'overdueTasksThreshold',label:'CS: предупредить, когда просроченных задач больше',value:5,min:0,max:10000},
  {key:'csmDailyCheckHour',label:'CS: час проверки нулевой активности МСК',value:13,min:0,max:23},
  {key:'invoiceNoPaymentDays',label:'Счёт без оплаты, будних дней',value:3,min:1,max:365},
  {key:'proposalStaleHours',label:'КП / возражения без движения, часов по будням',value:24,min:1,max:8760},
  {key:'preparedProposalDays',label:'КП подготовлено, но не презентовано, будних дней',value:2,min:1,max:365},
  {key:'highValueIdleAmount',label:'Крупная сделка: сумма больше, €',value:20000,min:0,max:100000000},
  {key:'highValueIdleHours',label:'Крупная сделка без движения, рабочих часов',value:24,min:1,max:8760},
] as const;
export const TELEGRAM_RULE_HELP: Record<string,string> = {
  amo_new_assigned_lead:'Новый входящий лид назначен менеджеру в продажах. Сообщение самому менеджеру.',
  amo_assigned_lead_10m:'Назначенный входящий лид не взят в работу к сроку напоминания.',
  amo_take_to_work_enabled:'Входящий лид не обработан в пределах рабочего срока.',
  amo_payment_received:'Сделка перешла в этап оплаты. Автосделка сборки не является новой оплатой.',
  amo_task_mass_reschedule:'Менеджер продаж массово перенёс задачи в одном временном окне.',
  amo_deal_mass_move:'Менеджер продаж массово переместил сделки в одном временном окне.',
  amo_csm_task_mass_reschedule:'Менеджер CS массово перенёс задачи.',
  amo_csm_deal_mass_move:'Менеджер CS массово переместил сделки.',
  amo_csm_overdue_tasks:'У менеджера CS превышен порог просроченных задач.',
  amo_csm_zero_taken_to_work_13:'К часу ежедневной проверки CS не взято ни одного лида в работу.',
  amo_csm_zero_offer_made_13:'К часу ежедневной проверки CS не отправлено ни одного КП.',
  amo_invoice_no_payment_3d:'Сделка в продажах остаётся на этапе счёта без оплаты дольше заданного срока.',
  amo_proposal_stale_24h:'Сделка в продажах остаётся на этапе КП / возражений дольше заданного срока.',
  amo_proposal_prepared_stale_2bd:'Подготовленное КП не презентовано клиенту к заданному сроку.',
  amo_high_value_idle_24h:'Крупная открытая сделка продаж без активности дольше заданного срока.',
};
export const TELEGRAM_VARIABLES=['managerMention','dealUrl','deal','manager','amount','stage','pipeline','group','taskCount','dealCount','checkTime'];
