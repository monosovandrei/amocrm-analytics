export interface AmoCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AmoAccount {
  id?: number;
  name?: string;
  subdomain?: string;
}

export interface AmoWebhookItem {
  entity: string;
  action: string;
  externalId: string | null;
  payload: Record<string, unknown>;
}

export interface AmoSyncMaps {
  pipelines: Map<string, string>;
  stages: Map<string, string>;
  users: Map<string, string>;
  contacts: Map<string, string>;
  companies: Map<string, string>;
  lossReasons: Map<string, string>;
  customerStatuses: Map<string, string>;
  customers: Map<string, string>;
}
