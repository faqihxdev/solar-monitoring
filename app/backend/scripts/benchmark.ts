// Synthetic fixture only. No env module, live database, DESS, SSH, or deployment.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Sqlite from "better-sqlite3";
import assert from "node:assert/strict";
import { TelemetryStore } from "../../server/store";
const root=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const executable=path.join(root,"target/release/examples",process.platform==="win32"?"benchmark.exe":"benchmark");
if(!fs.existsSync(executable))throw new Error("Build first: cargo build --release --locked --manifest-path backend/Cargo.toml --examples");
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),"solar-rust-bench-"));
const database=path.join(sandbox,"telemetry.db");const at=Math.floor(Date.now()/1000);const iterations=5;
let reader:TelemetryStore|undefined;
try{
  const initializer=await TelemetryStore.open(database);initializer.close();
  const writer=new Sqlite(database);writer.pragma("journal_mode=WAL");writer.pragma("synchronous=FULL");
  const insert=writer.prepare("INSERT INTO telemetry_snapshots(device_sn,device_gts,data_hash,payload_json,polled_at,battery_soc,battery_status,battery_power,pv_power,load_power,grid_voltage,grid_power,working_state) VALUES('sandbox',?,'synthetic','{}',?,?,?,?,?,?,?,?,'Battery mode')");
  const voltage=writer.prepare("INSERT INTO battery_voltage_readings(device_sn,sampled_at,sampled_at_raw,battery_voltage,mppt_battery_voltage,working_state,battery_soc) VALUES('sandbox',?,'synthetic',26.4,26.5,'Battery mode',70)");
  writer.transaction(()=>{for(let i=0;i<20000;i++){const t=at-600000+i*30;insert.run(`fixture-${i}`,t,70+i%20,1,0,300+i%1000,.609,0,0);if(i%4===0)voltage.run(t);}})();
  writer.prepare("INSERT INTO device_state VALUES('sandbox','synthetic','last',?)").run(at);writer.close();
  reader=await TelemetryStore.open(database,{readOnly:true});
  const measure=(fn:()=>unknown)=>{const result=fn();const times=[];for(let i=0;i<iterations;i++){const start=performance.now();fn();times.push(performance.now()-start);}times.sort((a,b)=>a-b);return{median_ms:times[Math.floor(times.length/2)],p95_ms:times[Math.ceil(times.length*.95)-1],result};};
  const summarize=(rows:Record<string,unknown>[])=>({points:rows.length,first:rows[0],last:rows.at(-1),encoded_bytes:Buffer.byteLength(JSON.stringify(rows))});
  const history=measure(()=>summarize(reader!.history("sandbox",168)));
  const history_200=measure(()=>{const rows=reader!.history("sandbox",168);const selected=Array.from({length:200},(_,i)=>rows[Math.round(i*(rows.length-1)/199)]);return summarize(selected);});
  const date=new Date((at+25200)*1000).toISOString().slice(0,10);const daily_7=measure(()=>reader!.dailyEnergyRange("sandbox",date,7));
  const readiness_100=measure(()=>{for(let i=0;i<100;i++)reader!.summary("sandbox");return{queries:100};});
  const legacy={runtime:"typescript",iterations,history,history_200,daily_7,readiness_100};
  const child=spawnSync(executable,[database,String(at),String(iterations)],{encoding:"utf8",timeout:120000,windowsHide:true});
  if(child.status!==0)throw new Error(child.stderr||`Rust benchmark exited ${child.status}`);
  const rust=JSON.parse(child.stdout);
  // JSON encoders differ in integral float spelling, so compare data independently of bytes.
  for(const key of ["history","history_200"]as const){const{encoded_bytes:legacyBytes,...expected}=legacy[key].result as ReturnType<typeof summarize>;const{encoded_bytes:rustBytes,...actual}=rust[key].result;assert.deepEqual(actual,expected);}
  assert.deepEqual(rust.daily_7.result,legacy.daily_7.result);
  const results=Object.fromEntries(["history","history_200","daily_7","readiness_100"].map(key=>{const l=(legacy as any)[key],r=rust[key];return[key,{typescript_median_ms:l.median_ms,rust_median_ms:r.median_ms,speedup:l.median_ms/r.median_ms,typescript_p95_ms:l.p95_ms,rust_p95_ms:r.p95_ms}]}));
  const report={fixture:{telemetry_points:20000,voltage_samples:5000,days:7,iterations},generated_at:new Date().toISOString(),platform:process.platform,node:process.version,results};
  fs.writeFileSync(path.join(root,"benchmark-results.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
}finally{
  reader?.close();const verified=fs.realpathSync(sandbox);if(path.dirname(verified)!==fs.realpathSync(os.tmpdir())||!path.basename(verified).startsWith("solar-rust-bench-"))throw new Error("Refusing cleanup outside benchmark sandbox");fs.rmSync(verified,{recursive:true,force:true});
}
