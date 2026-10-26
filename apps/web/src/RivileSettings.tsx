import { useState } from 'react';
import FieldCombobox from './FieldCombobox';
import { api } from './lib/api';
import { useWorkspaceResource, workspaceDate, workspaceError } from './workspace-data';
import SalesTargetProfiles, {type TargetProfile} from './SalesTargetProfiles';

type Link = { code: string; crmUserId: string | null; departmentKey: string | null; updatedAt: string; source: string };
export default function RivileSettings() {
    const {data,error,loading,reload}=useWorkspaceResource<{profiles:TargetProfile[];links:Link[];users:{id:string;name:string}[];departments:{key:string;name:string}[]}>('/workspaces/rivile/settings');
    const [draft,setDraft]=useState({code:'',crmUserId:'',departmentKey:'sales',version:''}),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
    async function save() {
        setBusy(true); setNotice('');
        try {await api('/workspaces/rivile/mapping',{method:'PATCH',body:JSON.stringify({...draft,confirmed})});setNotice('Связь подтверждена. Маржа будет пересчитана по сохранённым документам; изменение записано в журнал.');setConfirmed(false);setDraft({code:'',crmUserId:'',departmentKey:'sales',version:''});reload();}
        catch(e){setNotice(workspaceError(e));}finally{setBusy(false);}
    }
    return <section className="workspace-settings"><h2>Ривиле: связи менеджеров</h2><p>Маржа относится к менеджеру документа Ривиле. Похожие имена, клиенты и суммы не используются для автоматического назначения. Несвязанные документы останавливают рейтинг маржи.</p>
        {loading&&<p>Загрузка связей…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
        {data&&<><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Код Ривиле</th><th>Сотрудник amoCRM</th><th>Отдел</th><th>Подтверждено</th><th>Действие</th></tr></thead><tbody>{data.links.map(link=><tr key={link.code}><td>{link.code}</td><td>{data.users.find(u=>u.id===link.crmUserId)?.name||(link.departmentKey?'Сотрудник не найден':'Внешний код, без связи с amoCRM')}</td><td>{data.departments.find(d=>d.key===link.departmentKey)?.name||'Вне отделов продаж и CS'}</td><td>{workspaceDate(link.updatedAt)}</td><td><button className="btn" onClick={()=>{setDraft({code:link.code,crmUserId:link.crmUserId||'',departmentKey:link.departmentKey||'outside',version:link.updatedAt});setConfirmed(false);}}>Изменить</button></td></tr>)}</tbody></table>{!data.links.length&&<p>Связи ещё не настроены.</p>}</div>
        <form onSubmit={e=>{e.preventDefault();void save();}}><h3>Подтвердить связь</h3><div className="workspace-toolbar"><label><span className="label">Код менеджера Ривиле</span><input className="field" required maxLength={40} value={draft.code} onChange={e=>{const existing=data.links.find(l=>l.code===e.target.value);setDraft({...draft,code:e.target.value,version:existing?.updatedAt||''});setConfirmed(false);}}/></label>
            <FieldCombobox label="Сотрудник amoCRM" value={draft.crmUserId} onChange={id=>{setDraft({...draft,crmUserId:id});setConfirmed(false);}} options={data.users.map(u=>({value:u.id,label:u.name}))} placeholder="Выберите сотрудника"/>
            <label><span className="label">Коммерческий отдел</span><select className="field" value={draft.departmentKey} onChange={e=>{setDraft({...draft,departmentKey:e.target.value});setConfirmed(false);}}>{data.departments.map(d=><option key={d.key} value={d.key}>{d.name}</option>)}<option value="outside">Вне продаж и CS</option></select></label></div>
            <label className="workspace-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Я проверил код в Ривиле и сотрудника в amoCRM</label><button className="btn" disabled={busy||!confirmed||!draft.code||(draft.departmentKey!=='outside'&&!draft.crmUserId)}>{busy?'Сохранение…':'Подтвердить связь'}</button>
        </form><SalesTargetProfiles profiles={data.profiles} users={data.users} onSaved={reload}/></>}
    </section>;
}
