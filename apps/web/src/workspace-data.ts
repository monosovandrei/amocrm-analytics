import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './lib/api';

export const accessDenied = (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status);
export const WorkspaceConnectionContext = createContext('');
export function copyWorkspaceLink(value: string) { return navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject(new Error('Копирование недоступно в этом браузере')); }
export function workspaceError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    try { const message = JSON.parse(raw).message; return Array.isArray(message) ? message.join('. ') : message || raw; }
    catch { return /Failed to fetch|NetworkError|Load failed/i.test(raw) ? 'Нет соединения. Показанные данные не обновлены.' : raw; }
}
export const workspaceDate = (value: string | null) => value ? `${new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК` : 'Нет данных';
export function useWorkspaceResource<T>(path: string | null) {
    const connectionError = useContext(WorkspaceConnectionContext);
    const loadedPath = useRef<string | null>(null);
    const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
    useEffect(() => {
        let alive = true, busy = false;
        if (loadedPath.current !== path) setData(null);
        setError(''); setLoading(Boolean(path && loadedPath.current !== path));
        if (!path) return;
        const load = async () => {
            if (busy) return;
            busy = true;
            try { const result = await api<T>(path); if (alive) { loadedPath.current = path; setData(result); setError(''); } }
            catch (e) { if (alive) { if (accessDenied(e)) { loadedPath.current = null; setData(null); } setError(workspaceError(e)); } }
            finally { busy = false; if (alive) setLoading(false); }
        };
        void load();
        const timer = window.setInterval(load, 20000);
        const onOnline = () => { void load(); };
        window.addEventListener('online', onOnline);
        return () => { alive = false; clearInterval(timer); window.removeEventListener('online', onOnline); };
    }, [path, revision]);
    // A shared outage is reported once by the shell; permission and metric errors remain local.
    return { data: loadedPath.current === path ? data : null, error: connectionError && /^Нет соединения/.test(error) ? '' : error, loading, setData, reload: () => setRevision(r => r + 1) };
}
