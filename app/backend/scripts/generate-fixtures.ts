// Imports pure legacy modules only. Never imports server/env or opens a live database.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { CONTROL_FIELDS } from "../../server/controlCatalog";
import { thresholdCatalogDefaults } from "../../server/thresholds";
import { inferEnergyFlows, effectiveGridPower } from "../../shared/energyFlows";
import { extractReadings, TelemetryStore } from "../../server/store";
import { parseDetailsDat } from "../../server/details";
import { AutomationEngine } from "../../server/automation";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
fs.mkdirSync(path.join(root, "tests/fixtures"), { recursive: true });
fs.writeFileSync(path.join(root, "src/control_catalog.json"), JSON.stringify(CONTROL_FIELDS, null, 2) + "\n");
fs.writeFileSync(path.join(root, "src/threshold_catalog.json"), JSON.stringify(thresholdCatalogDefaults(), null, 2) + "\n");
const source = fs.readFileSync(path.join(root, "../server/store.ts"), "utf8");
const schema = source.match(/this\.db\.exec\(`([\s\S]+?)`\);/)![1];
const additions = [...["pv_to_load_kw","battery_to_load_kw","grid_to_load_kw","pv_to_battery_kw","grid_to_battery_kw"].map(k => `ALTER TABLE telemetry_snapshots ADD COLUMN ${k} REAL;`), ...["grid_to_battery_reported","grid_to_battery_unmetered","battery_flow_unmetered"].map(k => `ALTER TABLE telemetry_snapshots ADD COLUMN ${k} INTEGER;`)];
fs.writeFileSync(path.join(root, "src/schema.sql"), schema + "\n" + additions.join("\n") + "\n");
const energy = [];
for (const working_state of [null,"Mains mode","Battery mode","Off-grid mode","Utility on-line"]) {
  for (const battery_status of [null,-1,0,1]) {
    for (const pv_power of [null,0,3,274,606,1200]) {
      for (const load_power of [null,0,0.003,0.609,1.4]) {
        for (const grid_power of [null,0,-0.3,0.6]) {
          for (const battery_power of [null,0,0.003,0.25]) {
            const reading = {working_state,battery_status,pv_power,load_power,grid_power,battery_power,grid_voltage:220};
            energy.push({reading,flows:inferEnergyFlows(reading),effective:effectiveGridPower(reading)});
          }
        }
      }
    }
  }
}
fs.writeFileSync(path.join(root,"tests/fixtures/energy.json.gz"),gzipSync(Buffer.from(JSON.stringify(energy)), { level: 9 }));
const last = { gts:"fixture-gts", pars:{bt_:[{par:"SOC",val:"83"}],pv_:[{par:"PV power",val:"606",unit:"W"}],bc_:[{par:"Load current",val:"2.6",unit:"A"}],gd_:[{par:"Input voltage",val:"220",unit:"V"}],sy_:[{par:"Working state",val:"Battery mode"}]}};
const flow = {bt_status:[{par:"bt_battery_capacity",val:"83",status:1},{par:"battery_active_power",val:"0.003",unit:"kW"}],bc_status:[{par:"load_active",val:"0.609",unit:"kW"}],gd_status:[{par:"grid_active",val:"0",unit:"kW"}],pv_status:[{par:"pv_output",val:"0.606",unit:"kW"}]};
function stable(value: any): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`; }
const hashReadings = extractReadings(last, flow);
const hashInput = { gts: "gts-179", readings: hashReadings.readings, readings_raw: hashReadings.readingsRaw, load_flows: inferEnergyFlows(hashReadings.readings) };
fs.writeFileSync(path.join(root, "tests/fixtures/hash.json"), JSON.stringify({input:hashInput,canonical:stable(hashInput)}));
const details = {title:["Timestamp","Battery Voltage","MPPT Battery Voltage","Working State","BMS Lithium Battery Capacity SOC"].map(title=>({title})),row:[{field:JSON.stringify(["2026-09-30 13:15:00.125","26.4","26.5","Battery mode","70"])},{field:["2026-09-30 13:16:00","--","26.5","Battery mode","70"]}]};
fs.writeFileSync(path.join(root,"tests/fixtures/parsing.json"),JSON.stringify({last,flow,extracted:extractReadings(last,flow),details,samples:parseDetailsDat(details)}));
// All SQLite activity is confined to a new directory under OS temporary storage.
const os = await import("node:os");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(),"solar-rust-fixtures-"));
const db = path.join(sandbox,"telemetry.db");
const store = await TelemetryStore.open(db);
const at = 1790748000;
const originalNow = Date.now;
try {
  for(let i=0;i<180;i++) {
    Date.now = () => (at - 1800 + i*10)*1000;
    const payload = store.buildPayload({...last,gts:`gts-${i}`},flow);
    store.saveIfChanged("sandbox",payload);
  }
  store.upsertVoltageSamples("sandbox",[0,1,2,3].map(i=>({sampled_at:at-1500+i*300,sampled_at_raw:`raw-${i}`,battery_voltage:26+i*.1,mppt_battery_voltage:26.2,working_state:"Battery mode",battery_soc:70})));
  Date.now = () => at*1000;
  const fixture = {now:at,latest:store.latestReadings("sandbox"),history:store.history("sandbox",1),snapshots:store.recentSnapshots("sandbox",5),summary:store.summary("sandbox"),voltage:store.voltageHistory("sandbox",1),daily:store.dailyEnergyRange("sandbox","2026-09-30",2)};
  fs.writeFileSync(path.join(root,"tests/fixtures/store.json"),JSON.stringify(fixture));
  const automation = [];
  for (const minutes of [300,390,540,720,1035,1200]) {
    for (const target of [25,50,90,100]) {
      const when = Date.parse("2026-09-30T00:00:00+07:00")/1000 + minutes*60;
      Date.now = () => when*1000;
      const state = {device_sn:"sandbox",enabled:1,target_practical_soc:target,target_time:"17:15",baseline_a6:12.4,baseline_a7:11.7,active_override:0,override_a6:null,override_a7:null,override_value:null,next_check_at:null,last_decision:"tracking target",last_reason:"Fixture",updated_at:when};
      const engine = new AutomationEngine(store, {automationState:()=>state} as any, {} as any, "sandbox");
      automation.push({at:when,status:engine.status()});
    }
  }
  fs.writeFileSync(path.join(root,"tests/fixtures/automation.json"),JSON.stringify(automation));
  store.close();
  fs.copyFileSync(db,path.join(root,"tests/fixtures/telemetry.db"));
} finally {
  Date.now=originalNow;
  store.close();
  const verified = fs.realpathSync(sandbox);
  if (path.dirname(verified) !== fs.realpathSync(os.tmpdir()) || !path.basename(verified).startsWith("solar-rust-fixtures-")) throw new Error("Refusing cleanup outside fixture sandbox");
  fs.rmSync(verified,{recursive:true,force:true});
}
console.log(`Generated ${energy.length} energy parity cases and disposable database fixtures.`);
