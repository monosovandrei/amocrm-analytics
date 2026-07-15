const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api/v1';

export function apiUrl(path: string) {
  return `${API_URL}${path}`;
}

export function getToken() {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('accessToken') || '';
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function downloadExcel(path: string, body: unknown) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const job = await res.json();
    if (!job?.jobId) throw new Error('Export job was not created');
    await waitForExportJob(job.jobId);
    await downloadFile(`/reports/export-jobs/${job.jobId}/download`, 'report.xlsx');
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'report.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

async function waitForExportJob(jobId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    const job = await api<{ status: string; error?: string | null }>(`/reports/export-jobs/${jobId}`);
    if (job.status === 'SUCCESS') return;
    if (job.status === 'ERROR') throw new Error(job.error || 'Export failed');
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  throw new Error('Export is still running');
}

export async function downloadFile(path: string, fileName: string) {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
