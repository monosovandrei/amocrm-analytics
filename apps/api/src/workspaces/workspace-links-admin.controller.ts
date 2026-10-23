import {BadRequestException,Body,ConflictException,Controller,ForbiddenException,Get,Post,Query,Req,UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../auth/guards/jwt-auth.guard';
import {PrismaService} from '../prisma/prisma.service';
import {WorkspaceAccessService} from './workspace-access.service';

@Controller('workspaces/admin')
@UseGuards(JwtAuthGuard)
export class WorkspaceLinksAdminController {
  constructor(private readonly prisma:PrismaService,private readonly access:WorkspaceAccessService){}
  private async admin(userId:string){if((await this.access.resolve(userId)).role!=='ADMIN')throw new ForbiddenException('Только администратор может подтверждать связи');}
  @Get('unassigned')
  async unassigned(@Req() req:any,@Query() query:Record<string,string>){
    await this.admin(req.user.id);
    const month=query.month||new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date());
    if(!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))throw new BadRequestException('Некорректный месяц');
    const [year,number]=month.split('-').map(Number);
    const page=Math.max(1,Math.min(Math.floor(Number(query.page))||1,100000));
    const links=await this.prisma.commercialShipmentLink.findMany({select:{shipmentDealId:true,status:true,saleDealId:true}});
    const department=await this.prisma.workspaceDepartment.findFirst();if(!department)throw new BadRequestException('Воронка сборки не настроена');
    const start=new Date(`${month}-01T00:00:00+03:00`),end=new Date(Date.UTC(year,number,1)-3*3600000);
    const where:any={pipelineId:department.assemblyPipelineId,id:{notIn:links.filter(l=>l.status==='CONFIRMED').map(l=>l.shipmentDealId)},deletedAt:null};
    if(query.basis==='created')where.createdAt={gte:start,lt:end};
    else{
      const shipped=await this.prisma.factStageTransition.findMany({where:{toStageId:department.shippingStageId,movedAt:{gte:start,lt:end}},select:{dealId:true}});
      const relevant=await this.prisma.factDealCurrent.findMany({where:{pipelineId:department.assemblyPipelineId,deletedAt:null,OR:[{stageIsWon:false,stageIsLost:false},{dealId:{in:shipped.map(t=>t.dealId)}}]},select:{dealId:true}});
      where.id.in=relevant.map(d=>d.dealId);
    }
    const [total,rows]=await Promise.all([this.prisma.deal.count({where}),this.prisma.deal.findMany({where,select:{id:true,externalId:true,title:true,amount:true},orderBy:[{createdAt:'desc'},{id:'asc'}],skip:(page-1)*30,take:30})]);
    const byId=new Map(links.map(l=>[l.shipmentDealId,l]));
    const sources=await this.prisma.deal.findMany({where:{id:{in:rows.map(d=>byId.get(d.id)?.saleDealId).filter(Boolean) as string[]}},select:{id:true,externalId:true}});
    return {total,page,pageSize:30,rows:rows.map(d=>({id:d.id,externalId:d.externalId,title:d.title,amount:Number(d.amount),
      sourceExternalId:sources.find(s=>s.id===byId.get(d.id)?.saleDealId)?.externalId||null,
      reason:byId.get(d.id)?.status==='ALLOCATION_REQUIRED'?'Несколько сборок одной продажи: суммы частей не проверены':byId.get(d.id)?.status==='AMBIGUOUS'?'Несколько оплаченных исходных сделок':byId.get(d.id)?.saleDealId?'Не подтверждён исторический продавец':'Не найден однозначный идентификатор продажи'}))};
  }
  @Post('shipment-links')
  async resolve(@Req() req:any,@Body() body:Record<string,any>){
    const userId=req.user.id;await this.admin(userId);
    if(body.confirmed!==true)throw new BadRequestException('Подтвердите проверку исходной продажи и сборки');
    const raw=String(body.sourceExternalId||'').trim();let externalId=raw;
    if(raw.startsWith('http')){
      let url:URL;try{url=new URL(raw);}catch{throw new BadRequestException('Некорректная ссылка amoCRM');}
      const connection=await this.prisma.amoConnection.findFirst({orderBy:{createdAt:'desc'},select:{subdomain:true}});
      const domain=(connection?.subdomain||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
      if(url.protocol!=='https:'||url.hostname!==(domain.endsWith('.amocrm.ru')?domain:`${domain}.amocrm.ru`))throw new BadRequestException('Ссылка должна вести в вашу amoCRM');
      externalId=url.pathname.match(/^\/leads\/detail\/(\d+)\/?$/)?.[1]||'';
    }
    if(!/^\d+$/.test(externalId))throw new BadRequestException('Укажите ссылку или номер исходной продажи');
    const [shipment,sale,seller,departments]=await Promise.all([
      this.prisma.deal.findUnique({where:{id:String(body.shipmentDealId)}}),this.prisma.deal.findUnique({where:{externalId}}),
      this.prisma.crmUser.findUnique({where:{id:String(body.managerId)}}),this.prisma.workspaceDepartment.findMany(),
    ]);
    if(!shipment||!sale||!seller||!departments.some(d=>d.assemblyPipelineId===shipment.pipelineId)||sale.id===shipment.id)throw new BadRequestException('Проверьте продажу, сборку и продавца');
    const stages=await this.prisma.pipelineStage.findMany({where:{id:{in:departments.flatMap(d=>d.paymentStageIds)}},select:{id:true,externalId:true,pipeline:{select:{externalId:true}}}});
    const keys=new Map(stages.map(s=>[`${s.pipeline.externalId}:${s.externalId}`,departments.find(d=>d.paymentStageIds.includes(s.id))!.key]));
    const events=await this.prisma.crmEvent.findMany({where:{dealId:sale.id,type:'lead_status_changed',createdAt:{lte:shipment.createdAt}},orderBy:{createdAt:'desc'},select:{id:true,createdAt:true,valueAfter:true}});
    const paid=events.map(e=>{const value=e.valueAfter as any,item=Array.isArray(value)?value[0]:value,status=item?.lead_status||item?.status||item;return {...e,department:keys.get(`${status?.pipeline_id}:${status?.id}`)};}).find(e=>e.department);
    if(!paid)throw new BadRequestException('Нет исходного события оплаты до создания сборки');
    const other=await this.prisma.commercialShipmentLink.count({where:{saleDealId:sale.id,shipmentDealId:{not:shipment.id}}});
    if(other&&body.allocationConfirmed!==true)throw new BadRequestException('У продажи несколько сборок. Подтвердите, что суммы частей проверены и не дублируются');
    return this.prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Deal" WHERE id=${shipment.id} FOR UPDATE`;
      const old=await tx.commercialShipmentLink.findUnique({where:{shipmentDealId:shipment.id}});
      if(old?.status==='CONFIRMED')throw new ConflictException('Связь уже подтверждена. Перезапись исторического продавца запрещена');
      const data={saleDealId:sale.id,managerId:seller.id,departmentKey:paid.department!,status:'CONFIRMED',source:'manual-confirmed',effectiveAt:shipment.createdAt,
        evidence:{confirmedBy:userId,confirmedAt:new Date().toISOString(),paidEventId:paid.id,allocationConfirmed:body.allocationConfirmed===true}};
      await tx.commercialShipmentLink.upsert({where:{shipmentDealId:shipment.id},create:{shipmentDealId:shipment.id,...data},update:data});
      await tx.auditLog.create({data:{userId,action:'workspace.shipment-link.confirmed',entity:'CommercialShipmentLink',entityId:shipment.id,metadata:{before:old?{saleDealId:old.saleDealId,managerId:old.managerId,status:old.status}:null,after:{saleDealId:sale.id,managerId:seller.id,departmentKey:paid.department}}}});
      return {ok:true};
    });
  }
}
