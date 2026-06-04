export type JsonRecord = Record<string, unknown>;

export interface DeviceSettings {
  pn: string;
  sn: string;
  devcode: string;
  devaddr: string;
  i18n?: string;
}

export interface AuthSession {
  token: string;
  secret: string;
  expires_at: number;
}
