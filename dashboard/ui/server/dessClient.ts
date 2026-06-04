import { createHash } from "node:crypto";

const API_BASE = "https://web.dessmonitor.com/public/";

type JsonObject = Record<string, unknown>;

export class DessmonitorApiError extends Error {
  constructor(
    public readonly code: number,
    public readonly description: string,
  ) {
    super(`Dessmonitor API error ${code}: ${description}`);
  }
}

function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

function paramString(params: Record<string, string>, webStyle = false): string {
  const encoded = new URLSearchParams(params).toString();
  if (!webStyle) return encoded;
  return encoded
    .replace(/%20/g, "+")
    .replace(/%2B/g, "+")
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%40/g, "@")
    .replace(/%24/g, "$")
    .replace(/%26/g, "&")
    .replace(/%3D/g, "=")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
}

export class DessmonitorClient {
  token: string | null = null;
  secret: string | null = null;
  expiresAt = 0;

  constructor(
    private readonly usr: string,
    private readonly pwd: string,
    private readonly companyKey: string,
    public readonly source = "1",
  ) {}

  setSession(token: string, secret: string, expiresAt: number): void {
    this.token = token;
    this.secret = secret;
    this.expiresAt = expiresAt;
  }

  get sessionValid(): boolean {
    return Boolean(this.token && this.secret && Date.now() / 1000 < this.expiresAt - 60);
  }

  async authenticate(): Promise<JsonObject> {
    const salt = String(Date.now());
    const pwdHash = sha1Hex(this.pwd);
    const params = {
      action: "authSource",
      usr: this.usr,
      source: this.source,
      "company-key": this.companyKey,
    };
    const sign = sha1Hex(`${salt}${pwdHash}&${paramString(params, true)}`);
    const payload = await this.request({ sign, salt, ...params }, true);
    const dat = payload.dat as JsonObject;
    this.token = String(dat.token);
    this.secret = String(dat.secret);
    this.expiresAt = Date.now() / 1000 + Number(dat.expire ?? 604800);
    return payload;
  }

  async queryDeviceLastData(args: DeviceArgs): Promise<JsonObject> {
    await this.ensureSession();
    return this.signedRequest({
      action: "querySPDeviceLastData",
      source: this.source,
      devcode: args.devcode,
      pn: args.pn,
      devaddr: args.devaddr,
      sn: args.sn,
      i18n: args.i18n ?? "en_US",
    });
  }

  async queryDeviceDataOneDayPaging(args: DeviceArgs & { date: string; page?: number; pagesize?: number }): Promise<JsonObject> {
    await this.ensureSession();
    return this.signedRequest({
      action: "queryDeviceDataOneDayPaging",
      source: this.source,
      devcode: args.devcode,
      pn: args.pn,
      devaddr: args.devaddr,
      sn: args.sn,
      date: args.date,
      page: String(args.page ?? 0),
      pagesize: String(args.pagesize ?? 50),
      i18n: args.i18n ?? "en_US",
    });
  }

  async queryDeviceCtrlValue(args: DeviceArgs & { fieldId: string }): Promise<JsonObject> {
    await this.ensureSession();
    return this.signedRequest({
      action: "queryDeviceCtrlValue",
      source: this.source,
      devcode: args.devcode,
      pn: args.pn,
      devaddr: args.devaddr,
      sn: args.sn,
      id: args.fieldId,
      i18n: args.i18n ?? "en_US",
    });
  }

  async queryDeviceEnergyFlow(args: Omit<DeviceArgs, "i18n">): Promise<JsonObject> {
    await this.ensureSession();
    return this.signedRequest({
      action: "webQueryDeviceEnergyFlowEs",
      source: this.source,
      devcode: args.devcode,
      pn: args.pn,
      devaddr: args.devaddr,
      sn: args.sn,
    });
  }

  async queryDeviceLastRawData(args: DeviceArgs): Promise<JsonObject> {
    await this.ensureSession();
    return this.signedRequest({
      action: "queryDeviceLastData",
      source: this.source,
      devcode: args.devcode,
      pn: args.pn,
      devaddr: args.devaddr,
      sn: args.sn,
      i18n: args.i18n ?? "en_US",
    });
  }

  private async ensureSession(): Promise<void> {
    if (!this.sessionValid) await this.authenticate();
  }

  private async signedRequest(params: Record<string, string>): Promise<JsonObject> {
    if (!this.token || !this.secret) throw new Error("DESS session not authenticated");
    const salt = String(Date.now());
    const sign = sha1Hex(`${salt}${this.secret}${this.token}&${paramString(params)}`);
    const payload = await this.request({ sign, salt, token: this.token, ...params });
    if ([0x0010, 0x0005, 5, 16].includes(Number(payload.err))) {
      await this.authenticate();
      return this.signedRequest(params);
    }
    return payload;
  }

  private async request(params: Record<string, string>, webStyle = false): Promise<JsonObject> {
    const query = paramString(params, webStyle);
    const response = await fetch(`${API_BASE}?${query}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`DESS HTTP ${response.status}`);
    const payload = (await response.json()) as JsonObject;
    if (Number(payload.err) !== 0) {
      throw new DessmonitorApiError(Number(payload.err), String(payload.desc ?? "unknown error"));
    }
    return payload;
  }
}

export interface DeviceArgs {
  pn: string;
  sn: string;
  devcode: string;
  devaddr: string;
  i18n?: string;
}
