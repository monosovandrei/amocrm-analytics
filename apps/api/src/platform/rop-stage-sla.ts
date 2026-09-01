export type RopDepartmentKey = 'sales' | 'csm';

export type RopStageSlaSeedRule = {
  departmentKey?: RopDepartmentKey;
  pipelineNeedles?: string[];
  stageNeedles: string[];
  days: number | null;
  reason: string;
};

export const ROP_DEPARTMENTS: Array<{ key: RopDepartmentKey; label: string }> = [
  { key: 'sales', label: 'Продажи' },
  { key: 'csm', label: 'CSM' },
];

export const ROP_DEFAULT_STAGE_SLA_DAYS = 7;

export const ROP_STAGE_SLA_RULES: RopStageSlaSeedRule[] = [
  {
    pipelineNeedles: ['база'],
    stageNeedles: ['свободная', 'база'],
    days: null,
    reason: 'Свободная база исключена из SLA: это пул сделок, а не операционный этап.',
  },
  { departmentKey: 'sales', stageNeedles: ['назнач'], days: 1, reason: 'Назначенная сделка в продажах должна быть взята в работу за 1 день.' },
  { departmentKey: 'sales', stageNeedles: ['не', 'дозвон'], days: 3, reason: 'После недозвона нужен следующий шаг за 3 дня.' },
  { departmentKey: 'sales', stageNeedles: ['доставлено'], days: 3, reason: 'После валидного контакта нужен следующий шаг за 3 дня.' },
  { departmentKey: 'sales', stageNeedles: ['contact', 'valid'], days: 3, reason: 'После валидного контакта нужен следующий шаг за 3 дня.' },
  { departmentKey: 'sales', stageNeedles: ['квалиф'], days: 3, reason: 'Квалификация продаж не должна висеть дольше 3 дней.' },
  { departmentKey: 'sales', stageNeedles: ['потребность'], days: 3, reason: 'После уточнения потребности нужен следующий шаг за 3 дня.' },
  { departmentKey: 'sales', stageNeedles: ['кп'], days: 5, reason: 'После КП нужен контроль клиента в течение 5 дней.' },
  { departmentKey: 'sales', stageNeedles: ['возраж'], days: 7, reason: 'Возражения должны быть разобраны за 7 дней.' },
  { departmentKey: 'sales', stageNeedles: ['счет', 'отправ'], days: 5, reason: 'После отправки счета нужен контроль оплаты за 5 дней.' },
  { departmentKey: 'sales', stageNeedles: ['счёт', 'отправ'], days: 5, reason: 'После отправки счета нужен контроль оплаты за 5 дней.' },
  { departmentKey: 'csm', stageNeedles: ['взят', 'работ'], days: 7, reason: 'CSM-сделка в работе не должна висеть без движения дольше 7 дней.' },
  { departmentKey: 'csm', stageNeedles: ['квалиф'], days: 7, reason: 'CSM-квалификация не должна висеть без движения дольше 7 дней.' },
  { departmentKey: 'csm', stageNeedles: ['цен', 'запрош'], days: 3, reason: 'Запрошенную цену нужно дожать за 3 дня.' },
  { departmentKey: 'csm', stageNeedles: ['предлож'], days: 7, reason: 'После предложения CSM нужен контроль клиента за 7 дней.' },
  { departmentKey: 'csm', stageNeedles: ['счет', 'отправ'], days: 5, reason: 'После счета CSM нужен контроль оплаты за 5 дней.' },
  { departmentKey: 'csm', stageNeedles: ['счёт', 'отправ'], days: 5, reason: 'После счета CSM нужен контроль оплаты за 5 дней.' },
  { departmentKey: 'csm', stageNeedles: ['сопровождение', 'отгруз'], days: 14, reason: 'Сопровождение отгрузки контролируется по SLA 14 дней.' },
  { departmentKey: 'csm', stageNeedles: ['контроль', 'получения'], days: 7, reason: 'Контроль получения заказа должен закрываться за 7 дней.' },
];

export function normalizeRopName(value?: string | null) {
  return String(value ?? '').trim().toLowerCase();
}

export function ropNameIncludesAll(value: string | null | undefined, needles: string[]) {
  const normalized = normalizeRopName(value);
  return needles.every((needle) => normalized.includes(normalizeRopName(needle)));
}

export function resolveDefaultRopStageSla(
  departmentKey: RopDepartmentKey,
  pipelineName?: string | null,
  stageName?: string | null,
) {
  const rule = ROP_STAGE_SLA_RULES.find((item) => {
    if (item.departmentKey && item.departmentKey !== departmentKey) return false;
    if (item.pipelineNeedles && !ropNameIncludesAll(pipelineName, item.pipelineNeedles)) return false;
    return ropNameIncludesAll(stageName, item.stageNeedles);
  });
  if (rule) return { days: rule.days, reason: rule.reason };
  return {
    days: ROP_DEFAULT_STAGE_SLA_DAYS,
    reason: `Для этапа пока нет отдельного SLA, используется запасной порог ${ROP_DEFAULT_STAGE_SLA_DAYS} дн.`,
  };
}

export function ropDepartmentKeyFromInput(value?: string | null): RopDepartmentKey | null {
  const normalized = normalizeRopName(value);
  if (normalized === 'sales' || normalized.includes('продаж')) return 'sales';
  if (normalized === 'csm') return 'csm';
  return null;
}

export function isRealAmoExternalId(value?: string | null) {
  return /^\d+$/.test(String(value ?? '').trim());
}
