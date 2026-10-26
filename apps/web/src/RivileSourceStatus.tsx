import { useState } from 'react';
import { api } from './lib/api';
import { workspaceDate, workspaceError } from './workspace-data';

export default function RivileSourceStatus({ source, month, canEdit, unknownCodes, onRefresh }: { source: { status: string; reason: string | null; cutoffAt: string | null }; month: string; canEdit: boolean; unknownCodes?: string[]; onRefresh: () => void }) {
    const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
    async function refresh() {
        setBusy(true);
        try { await api('/workspaces/rivile/refresh', { method: 'POST', body: JSON.stringify({ month }) }); setNotice('Обновление запрошено. Данные появятся после фоновой загрузки; страница обновляется автоматически.'); onRefresh(); }
        catch(e) { setNotice(workspaceError(e)); }
        finally { setBusy(false); }
    }
    return <details className={source.status === 'CERTIFIED' ? 'workspace-source' : 'workspace-warning'} aria-label="Источник фактической маржи">
        <summary><span role="status">Ривиле: {source.status === 'CERTIFIED' ? 'данные загружены, менеджеры сопоставлены' : source.reason?.replace(/^Ривиле:\s*/, '') || 'данные требуют проверки'}</span></summary>
        <p>Последняя успешная загрузка: {workspaceDate(source.cutoffAt)}. Маржа рассчитана по проведённым документам оборудования, без НДС, с вычетом возвратов.</p>
        {Boolean(unknownCodes?.length) && <p>Не сопоставлены коды менеджеров: {unknownCodes!.map(c=>c==='(empty)'?'Без менеджера в документе':c).join(', ')}. Администратор может подтвердить их в настройках Ривиле.</p>}
        {canEdit && <button className="btn" disabled={busy} onClick={()=>void refresh()}>{busy?'Запрос…':'Обновить Ривиле'}</button>}
        {notice && <p role="status">{notice}</p>}
    </details>;
}
