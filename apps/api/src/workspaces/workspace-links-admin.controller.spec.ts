import { WorkspaceLinksAdminController } from './workspace-links-admin.controller';

describe('shipment link manual confirmation boundary',()=>{
  const req={user:{id:'admin'}};
  function fixture(role='ADMIN'){
    const p:any={deal:{findUnique:jest.fn()},crmUser:{findUnique:jest.fn()},workspaceDepartment:{findMany:jest.fn()},pipelineStage:{findMany:jest.fn()},crmEvent:{findMany:jest.fn()},commercialShipmentLink:{count:jest.fn().mockResolvedValue(0)},$transaction:jest.fn()};
    return {p,c:new WorkspaceLinksAdminController(p,{resolve:jest.fn().mockResolvedValue({role})} as any)};
  }
  it.each(['MANAGER','ROP'])('denies both reading and writing links for %s',async(role)=>{
    const {c,p}=fixture(role);await expect(c.unassigned(req,{})).rejects.toThrow('администратор');await expect(c.resolve(req,{})).rejects.toThrow('администратор');expect(p.deal.findUnique).not.toHaveBeenCalled();
  });
  it('requires human confirmation before source queries',async()=>{
    const {c,p}=fixture();await expect(c.resolve(req,{sourceExternalId:'123'})).rejects.toThrow('Подтвердите');expect(p.deal.findUnique).not.toHaveBeenCalled();
  });
  it('rejects a sale without a confirmed paid event',async()=>{
    const {c,p}=fixture();p.deal.findUnique.mockResolvedValueOnce({id:'assembly',pipelineId:'assembly',createdAt:new Date()}).mockResolvedValueOnce({id:'sale'});p.crmUser.findUnique.mockResolvedValue({id:'seller'});p.workspaceDepartment.findMany.mockResolvedValue([{key:'sales',assemblyPipelineId:'assembly',paymentStageIds:['paid']}]);p.pipelineStage.findMany.mockResolvedValue([{id:'paid',externalId:'142',pipeline:{externalId:'1'}}]);p.crmEvent.findMany.mockResolvedValue([]);
    await expect(c.resolve(req,{confirmed:true,shipmentDealId:'assembly',sourceExternalId:'123',managerId:'seller'})).rejects.toThrow('события оплаты');expect(p.$transaction).not.toHaveBeenCalled();
  });
});
