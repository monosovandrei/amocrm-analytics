import {BadRequestException,Body,ConflictException,Controller,ForbiddenException,Get,Param,Patch,Post,Query,Req,UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../auth/guards/jwt-auth.guard';
import {PrismaService} from '../prisma/prisma.service';
import {PlatformService} from './platform.service';
import {TelegramService} from './telegram.service';
import {TELEGRAM_PARAMETERS,TELEGRAM_RULE_HELP,TELEGRAM_SEND_LOCK,TELEGRAM_VARIABLES} from './telegram-configuration';
import {moscowDate,moscowParts} from '../common/date.util';

@Controller('platform/telegram/admin')
@UseGuards(JwtAuthGuard)
export class TelegramAdminController {
  constructor(private readonly db:PrismaService,private readonly platform:PlatformService,private readonly telegram:TelegramService){}
  private async admin(id:string){
    const user=await this.db.user.findUnique({where:{id},select:{id:true,role:true,businessRole:true,isActive:true}});
    if(!user?.isActive||(user.role!=='ADMIN'&&user.businessRole!=='OWNER'))throw new ForbiddenException('Только администратор управляет Telegram');
    return user;
  }
  @Get()
  async overview(@Req() req:any){
    const actor=await this.admin(req.user.id);
    const [settings,rules,users,crmUsers,chats,schedules,alerts,templates]=await Promise.all([
      this.db.telegramSettings.findUniqueOrThrow({where:{id:'default'}}),
      this.platform.listTelegramTemplates(actor as any),
      this.db.user.findMany({where:{isActive:true},select:{id:true,name:true,role:true,businessRole:true,departmentKey:true,crmUserId:true,telegramAccount:{select:{isActive:true,username:true}}},orderBy:{name:'asc'}}),
      this.db.crmUser.findMany({where:{isActive:true,isVisible:true},select:{id:true,name:true,group:{select:{name:true}},telegramAccount:{select:{isActive:true,username:true}}},orderBy:{name:'asc'}}),
      this.db.telegramChat.findMany({select:{id:true,title:true,isActive:true,userId:true},orderBy:{linkedAt:'desc'}}),
      this.platform.listSchedules(actor as any),this.platform.listAlerts(actor as any),
      this.db.reportTemplate.findMany({where:{userId:null},select:{id:true,name:true,config:true},orderBy:{name:'asc'}}),
    ]);
    return {settings,botConfigured:this.telegram.isConfigured,rules:rules.map((r:any)=>({...r,description:TELEGRAM_RULE_HELP[String(r.eventType)]||r.name})),
      users,crmUsers,chats,parameters:TELEGRAM_PARAMETERS,variables:TELEGRAM_VARIABLES,schedules,alerts,templates};
  }
  @Patch('settings')
  async settings(@Req() req:any,@Body() body:any){
    await this.admin(req.user.id);
    if(!Number.isInteger(body.version)||typeof body.enabled!=='boolean')throw new BadRequestException('Укажите версию и состояние отправки');
    const parameters:Record<string,number>={};
    for(const field of TELEGRAM_PARAMETERS){
      const value=body.parameters?.[field.key]??field.value;
      if(typeof value!=='number'||!Number.isFinite(value)||!Number.isInteger(value)||value<field.min||value>field.max)throw new BadRequestException(`Проверьте: ${field.label}`);
      parameters[field.key]=value;
    }
    const quality=body.quality||{};
    if(quality.recipientIds!==undefined&&(!Array.isArray(quality.recipientIds)||quality.recipientIds.some((id:unknown)=>typeof id!=='string')))throw new BadRequestException('Некорректные получатели');
    const ids=[...new Set<string>(quality.recipientIds||[])];
    if(typeof quality.enabled!=='boolean'||!Number.isInteger(quality.repeatMinutes)||quality.repeatMinutes<5||quality.repeatMinutes>10080||typeof quality.includeRecovery!=='boolean')throw new BadRequestException('Проверьте настройки аварийных уведомлений');
    const messages={open:String(quality.messages?.open||'Данные требуют проверки\nПроблема: {message}\nОбнаружено: {detectedAt}\nИнцидент: {incidentId}'),resolved:String(quality.messages?.resolved||'Данные восстановлены\nПроблема: {message}\nИсправлено: {resolvedAt}\nИнцидент: {incidentId}')};
    for(const text of Object.values(messages))if(text.length>4000||[...text.matchAll(/\{([^{}]+)\}/g)].some(m=>!['message','detectedAt','resolvedAt','incidentId'].includes(m[1])))throw new BadRequestException('Проверьте текст аварийного сообщения и вставки');
    const recipients=await this.db.user.count({where:{id:{in:ids as string[]},isActive:true,OR:[{role:'ADMIN'},{businessRole:'OWNER'}],telegramAccount:{is:{isActive:true}}}});
    if(quality.enabled&&(recipients!==ids.length||!ids.length))throw new BadRequestException('Для аварийных уведомлений выберите подключённых администраторов');
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${TELEGRAM_SEND_LOCK})`;
      const old=await tx.telegramSettings.findUniqueOrThrow({where:{id:'default'}});
      if(old.version!==body.version)throw new ConflictException('Настройки изменены в другой вкладке. Обновите страницу');
      const next=await tx.telegramSettings.update({where:{id:'default'},data:{enabled:body.enabled,parameters,quality:{enabled:quality.enabled,recipientIds:ids,repeatMinutes:quality.repeatMinutes,includeRecovery:quality.includeRecovery,messages},version:{increment:1},...(!old.enabled&&body.enabled?{resumedAt:new Date()}:{})}});
      await tx.auditLog.create({data:{userId:req.user.id,action:'telegram.settings.updated',entity:'TelegramSettings',entityId:'default',metadata:{before:old,after:next} as any}});
      return next;
    },{timeout:30000,maxWait:10000});
  }
  @Patch('rules/:eventType')
  async rule(@Req() req:any,@Param('eventType') eventType:string,@Body() body:any){
    await this.admin(req.user.id);
    if(!TELEGRAM_RULE_HELP[eventType])throw new BadRequestException('Неизвестное событие');
    const old=await this.db.notificationTemplate.findUniqueOrThrow({where:{eventType}});
    if(!Number.isInteger(body.version)||typeof body.isActive!=='boolean')throw new BadRequestException('Укажите версию и состояние правила');
    const text=String(body.body||'').trim();
    if(!text||text.length>4000)throw new BadRequestException('Текст должен содержать от 1 до 4000 символов');
    const unknown=[...text.matchAll(/\{([^{}]+)\}/g)].map(m=>m[1]).filter(v=>!TELEGRAM_VARIABLES.includes(v));
    if(unknown.length)throw new BadRequestException(`Неизвестные вставки: ${[...new Set(unknown)].join(', ')}`);
    const personal=['amo_new_assigned_lead','amo_assigned_lead_10m','amo_take_to_work_enabled'].includes(eventType);
    const modes=personal?['direct_responsible','system','disabled']:['system','selected','group','disabled',...(eventType==='amo_payment_received'?['direct_responsible']:[])];
    if(!modes.includes(body.deliveryMode))throw new BadRequestException('Выберите поддерживаемый режим доставки');
    const recipients:any[]=Array.isArray(body.recipients)?body.recipients:[];
    if(recipients.length>200||recipients.some(r=>!r||!['platform_user','crm_user'].includes(r.kind)||typeof r.id!=='string'))throw new BadRequestException('Некорректные получатели');
    const unique=[...new Map(recipients.map(r=>[`${r.kind}:${r.id}`,r])).values()] as Array<{kind:string;id:string}>;
    if(body.deliveryMode==='selected'){
      if(!unique.length)throw new BadRequestException('Выберите хотя бы одного получателя');
      for(const kind of ['platform_user','crm_user']){
        const ids=unique.filter(r=>r.kind===kind).map(r=>r.id),where={id:{in:ids},isActive:true,telegramAccount:{is:{isActive:true}}};
        const count=kind==='platform_user'?await this.db.user.count({where}):await this.db.crmUser.count({where});
        if(count!==ids.length)throw new BadRequestException('Один из получателей отключён или не подключил Telegram');
      }
    }
    const stored=body.deliveryMode==='system'?[]:[{kind:'delivery_mode',id:body.deliveryMode},...(body.deliveryMode==='selected'?unique:[])];
    const groupIds=[...new Set<string>(Array.isArray(body.groupIds)?body.groupIds:[])];
    if(groupIds.some(id=>typeof id!=='string'))throw new BadRequestException('Некорректные группы');
    if(body.deliveryMode==='group'&&(!groupIds.length||await this.db.telegramChat.count({where:{id:{in:groupIds},isActive:true}})!==groupIds.length))throw new BadRequestException('Выберите подключённые группы Telegram');
    if(body.isActive&&body.deliveryMode==='disabled')throw new BadRequestException('Для включения правила выберите получателей');
    return this.db.$transaction(async tx=>{
      const changed=await tx.notificationTemplate.updateMany({where:{id:old.id,version:body.version},data:{body:text,isActive:body.isActive,recipients:stored,groupIds,version:{increment:1},...(!old.isActive&&body.isActive?{enabledAt:new Date()}:{})}});
      if(changed.count!==1)throw new ConflictException('Правило изменено в другой вкладке. Обновите страницу');
      const next=await tx.notificationTemplate.findUniqueOrThrow({where:{id:old.id}});
      await tx.auditLog.create({data:{userId:req.user.id,action:'telegram.rule.updated',entity:'NotificationTemplate',entityId:old.id,metadata:{before:old,after:next} as any}});
      return next;
    });
  }
  @Get('history')
  async history(@Req() req:any,@Query() query:any){
    await this.admin(req.user.id);
    const page=Math.max(1,Math.floor(Number(query.page))||1),status=['SENT','SKIPPED','ERROR','QUEUED'].includes(query.status)?query.status:undefined;
    const where={channel:'TELEGRAM' as const,...(status?{status}:{})};
    const [total,rows]=await Promise.all([this.db.notificationDelivery.count({where}),this.db.notificationDelivery.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(page-1)*30,take:30,select:{id:true,status:true,message:true,error:true,createdAt:true,sentAt:true,payload:true,user:{select:{name:true}},telegramAccount:{select:{username:true,crmUser:{select:{name:true}},user:{select:{name:true}}}},telegramChat:{select:{title:true}}}})]);
    return {total,page,rows};
  }
  @Post('pause')
  async pause(@Req() req:any){
    await this.admin(req.user.id);
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${TELEGRAM_SEND_LOCK})`;
      const result=await tx.telegramSettings.update({where:{id:'default'},data:{enabled:false,version:{increment:1}}});
      await tx.auditLog.create({data:{userId:req.user.id,action:'telegram.paused',entity:'TelegramSettings',entityId:'default'}});
      return result;
    },{timeout:30000,maxWait:10000});
  }
  @Post('link-codes/:kind/:id')
  async code(@Req() req:any,@Param('kind') kind:string,@Param('id') id:string){
    await this.admin(req.user.id);
    if(kind==='user'){
      if(!await this.db.user.findFirst({where:{id,isActive:true},select:{id:true}}))throw new BadRequestException('Учётная запись отключена');
      return this.telegram.createLinkCode(id);
    }
    if(kind==='crm'){
      if(!await this.db.crmUser.findFirst({where:{id,isActive:true,isVisible:true},select:{id:true}}))throw new BadRequestException('Пользователь amoCRM отключён');
      return this.telegram.createCrmUserLinkCode(id);
    }
    throw new BadRequestException('Неизвестный тип подключения');
  }
  @Post('report-jobs/:kind')
  createReportJob(@Req() req:any,@Param('kind') kind:string,@Body() body:any){return this.saveReportJob(req.user.id,kind,body);}
  @Patch('connections/:kind/:id')
  async connection(@Req() req:any,@Param('kind') kind:string,@Param('id') id:string,@Body() body:any){
    await this.admin(req.user.id);
    if(!['user','crm','group'].includes(kind)||typeof body.isActive!=='boolean')throw new BadRequestException('Проверьте подключение и его состояние');
    return this.db.$transaction(async tx=>{
      const where=kind==='user'?{userId:id}:{crmUserId:id};
      const old=kind==='group'?await tx.telegramChat.findUnique({where:{id}}):await tx.telegramAccount.findUnique({where});
      if(!old)throw new BadRequestException('Подключение не найдено');
      if(kind==='group')await tx.telegramChat.update({where:{id:old.id},data:{isActive:body.isActive}});
      else await tx.telegramAccount.update({where:{id:old.id},data:{isActive:body.isActive}});
      await tx.auditLog.create({data:{userId:req.user.id,action:'telegram.connection.updated',entity:kind,entityId:old.id,metadata:{before:old.isActive,after:body.isActive}}});
      return {isActive:body.isActive};
    });
  }
  @Patch('report-jobs/:kind/:id')
  updateReportJob(@Req() req:any,@Param('kind') kind:string,@Param('id') id:string,@Body() body:any){return this.saveReportJob(req.user.id,kind,body,id);}
  private async saveReportJob(actorId:string,kind:string,body:any,id?:string){
    await this.admin(actorId);
    if(!['schedule','alert'].includes(kind))throw new BadRequestException('Неизвестный тип рассылки');
    if(id&&(!Number.isInteger(body.version)||body.version<1))throw new BadRequestException('Укажите версию рассылки');
    const name=String(body.name||'').trim(),ids=[...new Set<string>(Array.isArray(body.recipients)?body.recipients:[])];
    if(!name||name.length>150||typeof body.enabled!=='boolean'||!ids.length||ids.some(v=>typeof v!=='string'))throw new BadRequestException('Укажите название, состояние и получателей');
    const count=await this.db.user.count({where:{id:{in:ids},isActive:true,OR:[{role:'ADMIN'},{businessRole:'OWNER'}],telegramAccount:{is:{isActive:true}}}});
    if(count!==ids.length)throw new BadRequestException('Полный отчёт можно отправлять только подключённым администраторам');
    const template=await this.db.reportTemplate.findUnique({where:{id:String(body.reportTemplateId||'')}});
    if(!template||template.userId)throw new BadRequestException('Выберите системный отчёт');
    const config=template.config as any;
    const metrics=(config.contract?.metrics||[]).map((m:any)=>`summaryRows.0.metrics.${m.id}.value`);
    const time=String(body.timeOfDay||'');
    if(kind==='schedule'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new BadRequestException('Укажите время МСК в формате ЧЧ:ММ');
    if(kind==='alert'&&(!metrics.includes(body.metricKey)||!['GT','GTE','LT','LTE','EQ','NEQ'].includes(body.operator)||typeof body.threshold!=='number'||!Number.isFinite(body.threshold)||body.threshold<0||!Number.isInteger(body.checkEveryMinutes)||body.checkEveryMinutes<5||body.checkEveryMinutes>1440||!Number.isInteger(body.cooldownMinutes)||body.cooldownMinutes<5||body.cooldownMinutes>10080))throw new BadRequestException('Проверьте показатель, порог и интервалы');
    const parts=moscowParts(new Date()),[hour,minute]=time.split(':').map(Number);
    let next=moscowDate(parts.year,parts.month,parts.day,hour||0,minute||0);
    if(next<=new Date())next=moscowDate(parts.year,parts.month,parts.day+1,hour||0,minute||0);
    return this.db.$transaction(async tx=>{
      const common={name,enabled:body.enabled,reportTemplateId:template.id,recipients:ids};
      let result;
      if(kind==='schedule'){
        const data={...common,frequency:'DAILY' as const,timeOfDay:time,timezone:'Europe/Moscow',format:'telegram',nextRunAt:body.enabled?next:null};
        if(id){const n=await tx.reportSchedule.updateMany({where:{id,version:body.version},data:{...data,version:{increment:1}}});if(n.count!==1)throw new ConflictException('Рассылка изменена в другой вкладке');result=await tx.reportSchedule.findUnique({where:{id}});}
        else result=await tx.reportSchedule.create({data:{...data,userId:actorId}});
      }else{
        const data={...common,metricKey:body.metricKey,operator:body.operator,threshold:body.threshold,checkEveryMinutes:body.checkEveryMinutes,cooldownMinutes:body.cooldownMinutes};
        if(id){const n=await tx.alertRule.updateMany({where:{id,version:body.version},data:{...data,version:{increment:1}}});if(n.count!==1)throw new ConflictException('Условие изменено в другой вкладке');result=await tx.alertRule.findUnique({where:{id}});}
        else result=await tx.alertRule.create({data:{...data,userId:actorId}});
      }
      await tx.auditLog.create({data:{userId:actorId,action:'telegram.report-job.saved',entity:kind,entityId:result!.id,metadata:{enabled:body.enabled,recipientIds:ids}}});
      return result;
    });
  }
}
