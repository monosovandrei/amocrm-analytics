export const RELEASE_BUILD_ID = process.env.BUILD_ID || process.env.REVISION || 'development';
export const METRIC_VERSION = process.env.METRIC_VERSION || '2026-10-23.1';
export const REQUIRED_WORKER_ROLES = ['sync', 'report', 'notification', 'export', 'bootstrap'];
