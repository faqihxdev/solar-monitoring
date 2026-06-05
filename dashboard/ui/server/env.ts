import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const uiRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const projectRoot = path.resolve(uiRoot, "../..");

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  usr: env("DESS_USR"),
  pwd: env("DESS_PWD"),
  companyKey: env("DESS_COMPANY_KEY"),
  pn: env("DESS_PN"),
  sn: env("DESS_SN"),
  devcode: process.env.DESS_DEVCODE ?? "6513",
  devaddr: process.env.DESS_DEVADDR ?? "1",
  i18n: process.env.DESS_I18N ?? "en_US",
  dbPath: path.resolve(projectRoot, process.env.DESS_DB_PATH ?? "data/solar.db"),
  controlDbPath: path.resolve(projectRoot, process.env.DESS_CONTROL_DB_PATH ?? "data/solar-control.db"),
  apiPort: Number(process.env.DESS_DASHBOARD_PORT ?? "8080"),
};

export function sqlJsWasmPath(file: string): string {
  return fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url));
}
