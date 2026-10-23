import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chooseShipmentSource, identifier, responsibleExternalId, fileIds } from './shipment-link-policy';
import { Prisma } from '../generated/prisma';
@Injectable()
export class CommercialLinksService {
    constructor(private readonly prisma: PrismaService) { }
    async revision(){return (await this.prisma.commercialShipmentLink.aggregate({_max:{updatedAt:true}}))._max.updatedAt?.toISOString()||'none';}
    async assignment(dealIds: string[]) {
        if (!dealIds.length)
            return new Map<string, any>();
        const links = await this.prisma.commercialShipmentLink.findMany({ where: { shipmentDealId: { in: dealIds } } });
        const users = await this.prisma.crmUser.findMany({ where: { id: { in: [...new Set(links.map(l => l.managerId).filter(Boolean) as string[])] } }, include: { group: true } });
        const userById = new Map(users.map(u => [u.id, u]));
        return new Map(links.map(l => [l.shipmentDealId, { ...l, manager: l.managerId ? userById.get(l.managerId) : null }]));
    }
    async attribute<T extends {
        id: string;
        pipelineId: string;
    }>(deals: T[]): Promise<any[]> {
        if (!deals.length)
            return deals;
        const departments = await this.prisma.workspaceDepartment.findMany();
        const assembly = new Set(departments.map(d => d.assemblyPipelineId));
        const map = await this.assignment(deals.filter(d => assembly.has(d.pipelineId)).map(d => d.id));
        return deals.map(deal => {
            if (!assembly.has(deal.pipelineId))
                return deal;
            const link = map.get(deal.id);
            const known = link?.status === 'CONFIRMED' && link.manager;
            const department = departments.find(d => d.key === link?.departmentKey);
            return { ...deal, commercialLink: link ? { saleDealId: link.saleDealId, status: link.status, departmentKey: link.departmentKey } : null,
                responsibleId: known ? link.manager.id : 'unassigned-commercial',
                responsible: { id: known ? link.manager.id : 'unassigned-commercial', name: known ? link.manager.name : 'Не распределено',
                    groupId: department?.groupId ?? null, group: department ? { id: department.groupId, name: department.name } : null } };
        });
    }
    async assemblyScope(assemblyPipelineId: string, departmentKey?: string, managerIds?: string[]) {
        const links = await this.prisma.commercialShipmentLink.findMany({ where: {
                status: 'CONFIRMED', ...(departmentKey ? { departmentKey } : {}), ...(managerIds ? { managerId: { in: managerIds } } : {}),
            }, select: { shipmentDealId: true } });
        return { pipelineId: assemblyPipelineId, dealId: { in: links.map(l => l.shipmentDealId) } };
    }
    async reconcile(limit = 100) {
        const departments = await this.prisma.workspaceDepartment.findMany();
        if (!departments.length)
            return { checked: 0, confirmed: 0 };
        const fields = await this.prisma.customFieldDefinition.findMany({ where: { entityType: 'LEAD' }, select: { externalId: true, name: true } });
        const invoice = fields.find(f => f.name.toLowerCase().replace(/\s+/g, '') === '№счета');
        const document = fields.find(f => f.name.trim().toLowerCase() === 'proforma invoice');
        const finalDocument=fields.find(f=>f.name.trim().toLowerCase()==='final invoice')?.externalId||document?.externalId;
        if (!invoice || !document)
            return { checked: 0, confirmed: 0, reason: 'Не настроены идентификаторы счёта и документа' };
        type Card = {
            id: string;
            invoice: unknown;
            document: unknown;
            createdAt: Date;
            updatedAt: Date;
            pipelineId: string;
            responsibleId: string | null;
        };
        const sources = await this.prisma.$queryRaw<Card[]> `SELECT id, "customFields"->${invoice.externalId}->'value' AS invoice,
      jsonb_build_array("customFields"->${document.externalId}->'value',"customFields"->${finalDocument!}->'value') AS document, "createdAt", "updatedAt", "pipelineId", "responsibleId" FROM "Deal"
      WHERE "pipelineId" <> ${departments[0].assemblyPipelineId} AND ("customFields"->${invoice.externalId}->'value' IS NOT NULL OR "customFields"->${document.externalId}->'value' IS NOT NULL OR "customFields"->${finalDocument!}->'value' IS NOT NULL)`;
        const candidates = new Map<string, Card[]>();
        const documents=new Map<string,Card[]>();
        for (const source of sources) {
            const key = identifier(source.invoice);
            if (key)
                candidates.set(key, [...(candidates.get(key) || []), source]);
            for(const file of fileIds(source.document))documents.set(file,[...(documents.get(file)||[]),source]);
        }
        const paymentStages=await this.prisma.pipelineStage.findMany({where:{id:{in:departments.flatMap(d=>d.paymentStageIds)}},select:{id:true,externalId:true,pipeline:{select:{externalId:true}}}});
        const paymentKeys=new Map(paymentStages.map(stage=>[`${stage.pipeline.externalId}:${stage.externalId}`,departments.find(d=>d.paymentStageIds.includes(stage.id))!.key]));
        const paidByDeal=new Map<string,Array<{id:string;at:Date;departmentKey:string}>>();
        for(let offset=0;offset<sources.length;offset+=1000){
            const events=await this.prisma.crmEvent.findMany({where:{type:'lead_status_changed',dealId:{in:sources.slice(offset,offset+1000).map(d=>d.id)}},select:{id:true,dealId:true,createdAt:true,valueAfter:true}});
            for(const event of events){
                const values=event.valueAfter as any;
                const value=Array.isArray(values)?values[0]:values;
                const status=value?.lead_status||value?.status||value;
                const departmentKey=paymentKeys.get(`${status?.pipeline_id}:${status?.id}`);
                if(departmentKey&&event.dealId)paidByDeal.set(event.dealId,[...(paidByDeal.get(event.dealId)||[]),{id:event.id,at:event.createdAt,departmentKey}]);
            }
        }
        const pending = await this.prisma.$queryRaw<Card[]> `SELECT d.id, d."customFields"->${invoice.externalId}->'value' AS invoice,
      jsonb_build_array(d."customFields"->${document.externalId}->'value',d."customFields"->${finalDocument!}->'value') AS document, d."createdAt", d."updatedAt", d."pipelineId", d."responsibleId"
      FROM "Deal" d LEFT JOIN "CommercialShipmentLink" l ON l."shipmentDealId"=d.id
      WHERE d."pipelineId"=${departments[0].assemblyPipelineId} AND d."deletedAt" IS NULL AND (l.status IS NULL OR l.status NOT IN ('CONFIRMED','ALLOCATION_REQUIRED') OR l.source IN ('invoice-document-identity','invoice-document-payment-identity'))
      ORDER BY l."checkedAt" ASC NULLS FIRST, d."createdAt" DESC LIMIT ${limit}`;
        let confirmed = 0;
        const previousLinks=new Map((await this.prisma.commercialShipmentLink.findMany({where:{shipmentDealId:{in:pending.map(d=>d.id)}}})).map(link=>[link.shipmentDealId,link]));
        for (const shipment of pending) {
            const linkedCandidates=new Map([...candidates.get(identifier(shipment.invoice)||'')||[],...fileIds(shipment.document).flatMap(file=>documents.get(file)||[])].map(c=>[c.id,c]));
            const eligible=[...linkedCandidates.values()].map(candidate=>({...candidate,paidAt:(paidByDeal.get(candidate.id)||[]).filter(p=>p.at<=shipment.createdAt).sort((a,b)=>+b.at-+a.at)[0]?.at||null}));
            const selected = chooseShipmentSource(shipment, eligible);
            let managerId: string | null = null, departmentKey: string | null = null;
            if (selected.saleDealId) {
                const sale = sources.find(s => s.id === selected.saleDealId)!;
                const previousEvent=await this.prisma.crmEvent.findFirst({where:{dealId:sale.id,type:'entity_responsible_changed',createdAt:{lte:shipment.createdAt}},orderBy:[{createdAt:'desc'},{externalId:'desc'}],select:{valueAfter:true,valueBefore:true,id:true}});
                const nextEvent=previousEvent?null:await this.prisma.crmEvent.findFirst({where:{dealId:sale.id,type:'entity_responsible_changed',createdAt:{gt:shipment.createdAt}},orderBy:[{createdAt:'asc'},{externalId:'asc'}],select:{valueBefore:true,valueAfter:true,id:true}});
                const nativeEvent=previousEvent||nextEvent;
                const nativeOwner=responsibleExternalId(previousEvent?previousEvent.valueAfter:nextEvent?.valueBefore);
                if(nativeEvent&&nativeOwner)managerId=(await this.prisma.crmUser.findUnique({where:{externalId:nativeOwner},select:{id:true}}))?.id||null;
                const future = await this.prisma.dealResponsibleHistory.findFirst({ where: { dealId: sale.id, changedAt: { gt: shipment.createdAt } }, orderBy: { changedAt: 'asc' } });
                const prior = await this.prisma.dealResponsibleHistory.findFirst({ where: { dealId: sale.id, changedAt: { lte: shipment.createdAt } }, orderBy: { changedAt: 'desc' } });
                if(!nativeEvent)managerId = prior ? prior.toUserId : future ? future.fromUserId : null;
                // Copied responsible is corroboration only, not a fallback to a logistics owner.
                if (!nativeEvent && !prior && !future && !managerId && sale.updatedAt <= shipment.createdAt && sale.responsibleId === shipment.responsibleId)
                    managerId = sale.responsibleId;
                departmentKey = (paidByDeal.get(sale.id)||[]).filter(p=>p.at<=shipment.createdAt).sort((a,b)=>+b.at-+a.at)[0]?.departmentKey||null;
            }
            const status = selected.saleDealId && managerId && departmentKey ? 'CONFIRMED' : selected.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNRESOLVED';
            const paid=selected.saleDealId?(paidByDeal.get(selected.saleDealId)||[]).filter(p=>p.at<=shipment.createdAt).sort((a,b)=>+b.at-+a.at)[0]:null;
            const data = { saleDealId: selected.saleDealId, managerId, departmentKey, status, source: 'invoice-payment-v2', effectiveAt: shipment.createdAt, evidence: {...selected.evidence,...(paid?{paidEventId:paid.id,paidAt:paid.at.toISOString()}:{})} };
            const previous=previousLinks.get(shipment.id);
            const evidenceKeys=[...new Set([...Object.keys(previous?.evidence||{}),...Object.keys(data.evidence)])].sort();
            const changed=!previous||previous.saleDealId!==data.saleDealId||previous.managerId!==data.managerId||previous.departmentKey!==data.departmentKey||previous.status!==data.status||previous.source!==data.source||JSON.stringify(previous.evidence,evidenceKeys)!==JSON.stringify(data.evidence,evidenceKeys);
            if(changed){
                await this.prisma.commercialShipmentLink.upsert({where:{shipmentDealId:shipment.id},create:{shipmentDealId:shipment.id,...data},update:{}});
                await this.prisma.commercialShipmentLink.updateMany({where:{shipmentDealId:shipment.id,source:{not:'manual-confirmed'},
                    OR:[{status:{notIn:['CONFIRMED','ALLOCATION_REQUIRED']}},{source:{in:['invoice-document-identity','invoice-document-payment-identity']}}]},data});
            }
            if (status === 'CONFIRMED')
                confirmed++;
        }
        if(pending.length)await this.prisma.$executeRaw`UPDATE "CommercialShipmentLink" SET "checkedAt"=NOW() WHERE "shipmentDealId" IN (${Prisma.join(pending.map(d=>d.id))})`;
        // Multiple assembly copies require a human allocation decision, not N copies of sale revenue.
        await this.prisma.$executeRaw`UPDATE "CommercialShipmentLink" l SET status='ALLOCATION_REQUIRED', "updatedAt"=NOW(),
          evidence=COALESCE(l.evidence,'{}'::jsonb)||'{"reason":"multiple-shipments-require-confirmed-allocation"}'::jsonb
          WHERE l.status='CONFIRMED' AND l.source<>'manual-confirmed' AND l."saleDealId" IN (
            SELECT related."saleDealId" FROM "CommercialShipmentLink" related JOIN "Deal" card ON card.id=related."shipmentDealId"
            WHERE related."saleDealId" IS NOT NULL AND card."deletedAt" IS NULL GROUP BY related."saleDealId" HAVING COUNT(*)>1)`;
        return { checked: pending.length, confirmed };
    }
}
