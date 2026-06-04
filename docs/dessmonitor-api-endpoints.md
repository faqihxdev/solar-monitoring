# DESSMonitor API Endpoints

Notes captured after logging into [www.dessmonitor.com](https://www.dessmonitor.com) on 2026-06-02.
Use this as a starting point for building a custom UI and database sync layer.

Official docs: https://api.dessmonitor.com/en/chapter1/apiHelp.html

---

## Base URLs

| Service | URL | Purpose |
|---------|-----|---------|
| Primary API (documented) | `https://api.dessmonitor.com/public/` | Official Open Platform API |
| Web API (used by portal) | `https://web.dessmonitor.com/public/` | Same action-based API used by the web app |
| Web portal | `https://www.dessmonitor.com/` | Vue SPA frontend |
| Domain validation | `https://hmi.eybond.com/hmi/api/hmi/domain/check/shineOrDess/auth/checkDomainPass/2` | Checks domain access |
| App config | `https://aam.eybond.com/ws/` | Domain/app metadata (`action=queryDomainApp`) |
| Consult params | `https://cfb.eybond.com/cfb/api/` | UI/config params (`action=consultParam/getParam`) |
| Client tasks | `https://cps.eybond.com/cps/` | Background tasks (`action=getTask`) |

For a custom backend, target **`web.dessmonitor.com/public/`** or **`api.dessmonitor.com/public/`** — both use the same `action` query-param pattern.

---

## Authentication

All requests are **HTTP GET** returning JSON: `{ err, desc, dat }`.

### 1. Login — `authSource`

```
GET /public/?sign=...&salt=...&action=authSource&usr={email}&source=1&company-key={key}
```

**Sign formula (auth only):**
```
sign = SHA1(salt + SHA1(password) + "&action=authSource&usr=" + usr + "&company-key=" + company-key + "&source=" + source)
```

**Response (`dat`):**
- `token` — session token (required on all later calls)
- `secret` — signing secret (required on all later calls)
- `expire` — validity in seconds (typically 604800 = 7 days)
- `role` — account role

**Observed values for www.dessmonitor.com:**
- `company-key`: `<your-company-key>`
- `source`: `1` (energy storage; use `0` for photovoltaic)
- `_app_client_`: `web`
- `_app_id_`: `www.dessmonitor.com`
- `_app_version_`: `1.0.6.3`

### 2. Signed business requests

All non-auth calls include `sign`, `salt`, and `token`:

```
GET /public/?sign=...&salt=...&token=...&action={actionName}&source=1&{params}
```

**Sign formula (all other actions):**
```
sign = SHA1(salt + secret + token + "&action=" + action + "&" + remainingParamsInOrder)
```

Notes:
- `salt` = current timestamp in ms (e.g. `Date.now()`)
- `&action=...` and all subsequent params are concatenated **after** salt/secret/token for signing
- In the URL, `sign`, `salt`, `token` come first, then `action`, then other params

### 3. Token refresh

| Action | Purpose |
|--------|---------|
| `updateToken` | Refresh expired token |
| `logoutVerifiction` | Logout / invalidate session |

---

## Endpoints Observed After Login (Home Dashboard)

These were captured from live network traffic when loading `#/generalNew/home`:

| Action | Key params | Purpose |
|--------|-----------|---------|
| `queryDomainListNotLogin` | `_app_client_=web`, `_app_id_=www.dessmonitor.com` | Domain list before login |
| `queryDomainList` | same + token | Domain list after login |
| `queryAccountInfo` | — | Current user profile |
| `editAccount` | — | Update account settings |
| `webEditMsgBox` | — | In-app message box |
| `webQueryDeviceEs` | `devtype=2304`, `page`, `pagesize` | List energy-storage devices |
| `webQueryPlantsWarning` | `devtype=2304`, `handle=false` | Plant/device warnings |
| `flowExpirationDetection` | — | SIM/data-plan expiry check |
| `queryPlantsInfoEs` | `devtype=2304`, `page`, `pagesize` | Projects/plants list |
| `queryCollectorinfoEs` | `pn` | Collector (datalogger) info |
| `webQueryDeviceEnergyFlowEs` | `devcode`, `pn`, `devaddr`, `sn` | Real-time energy flow diagram |
| `querySPDeviceLastData` | `devcode`, `pn`, `devaddr`, `sn`, `i18n` | Latest device telemetry |

### Account device identifiers (from this login)

| Field | Value |
|-------|-------|
| Account | `user@example.com` |
| Display name | Sample User |
| Collector PN | `<your-collector-pn>` |
| Device SN | `<your-device-sn>` |
| Device address | `1` |
| Protocol code (`devcode`) | `6513` |
| Device type (`devtype`) | `2304` (energy storage) |

---

## Endpoint Catalog (Official API)

Grouped by domain. Full parameter docs: `https://api.dessmonitor.com/en/{chapter}/{action}.html`

### Account (chapter 2)

| Action | Purpose |
|--------|---------|
| `authSource` | Authenticate, get token/secret |
| `queryAccountInfo` | Get account details |
| `editAccount` | Update account |
| `updatePassword` | Change password |
| `updateToken` | Refresh token |
| `reg` | Register new account |
| `disableOrEnableAccount` | Enable/disable account |
| `webEditMsgBox` | Message box CRUD |

### Plants / Projects (chapter 3)

| Action | Purpose |
|--------|---------|
| `queryPlantsInfoEs` | List projects and owners |
| `queryPlants` | Query plants |
| `addPlantEs` | Create project |
| `editPlantEs` | Edit project |
| `delPlantEs` | Delete project |
| `webQueryPlantsWarning` | Plant warnings |
| `ignorePlantWarning` | Dismiss warning |
| `queryPlantActiveOuputPowerOneDay` | Daily plant output power |
| `editPlantEnergyOffset` | Energy offset settings |
| `editCollectorPidEs` | Assign collector to project |
| `editUsrCurveDataOpt` | User chart preferences |

### Collectors / Dataloggers (chapter 4)

| Action | Purpose |
|--------|---------|
| `webQueryCollectorsEs` | List collectors (paginated) |
| `queryCollectorCountEs` | Collector count |
| `queryCollectorInfo` / `queryCollectorInfoEs` | Single collector info |
| `queryCollectorinfoEs` | Collector info (web variant) |
| `queryCollectorDevices` | Devices on a collector |
| `queryCollectorAddressEs` | Collector address/location |
| `webQueryGprsCollector` / `webQueryGprsCollectorEs` | GPRS/SIM status |
| `addCollectorEs` | Add collector |
| `editCollectorEs` | Edit collector |
| `delCollectorFromPlant` | Remove collector from project |
| `sendCmdToDevice` | Send raw hex command to device |

### Devices — Core (chapter 5)

| Action | Purpose |
|--------|---------|
| `webQueryDeviceEs` | List devices |
| `queryDevices` | Query devices |
| `queryDeviceInfo` | Device details |
| `webQueryDeviceEnergyFlowEs` | Energy flow diagram data |
| `webQueryDeviceStatusViewEs` | Device status view |
| `webQueryDevcodeViewEs` | Protocol/view by devcode |
| `queryDeviceStatus` | Device online/status |
| `queryDeviceLastData` | Last reported data |
| `queryDeviceLastRawData` | Last raw data |
| `queryDeviceParsEs` | Device parameters |
| `queryDeviceFields` | Available data fields |
| `queryDeviceDevcodes` | Supported protocol codes |
| `queryVendorCode` | Vendor codes |
| `editDeviceInfo` | Edit device metadata |
| `editDeviceFocusEs` | Follow/unfollow device |
| `delDeviceFromPlant` | Remove device from project |

### Devices — Historical Data & Charts (chapter 5)

| Action | Purpose |
|--------|---------|
| `queryDeviceDataOneDay` | All data for one day |
| `queryDeviceDataOneDayPaging` | Paginated daily data |
| `queryDeviceRawDataOneDay` | Raw daily data |
| `queryDeviceKeyParameterOneDay` | Key params for one day |
| `queryDeviceKeyParameterDay` | Key params by day |
| `queryDeviceKeyParameterMonth` | Key params by month |
| `queryDeviceKeyParameterYear` | Key params by year |
| `queryDeviceChartField` | Chart field definitions |
| `queryDeviceChartsFieldsEs` | Chart fields (ES) |
| `queryDeviceChartFieldDetailData` | Chart detail data |
| `queryDeviceSoleChartEs` | Single-device chart |
| `exportDeviceDataDetail` | Export data detail |
| `exportDeviceDataEs` | Export device data |

### Devices — Control & Alarms (chapter 5)

| Action | Purpose |
|--------|---------|
| `ctrlDevice` | Send control command (`id` + `val`; same as Control → Send in portal) |
| `queryDeviceCtrlField` | Available control fields |
| `queryDeviceCtrlValue` | Current control values (requires `id` per field) |
| `queryDeviceWarning` | Device alarms |
| `queryDeviceWarningCount` | Alarm count |
| `queryDeviceFirmwareUpgradeLastRecord` | Last firmware upgrade |

### Energy Storage — Key Parameters (chapter 14)

Prefix groups in responses: `bt_` battery, `pv_` solar, `by_` load, `gd_` grid, `sy_` system.

| Action | Purpose |
|--------|---------|
| `querySPDeviceLastData` | Latest telemetry snapshot |
| `querySPKeyParameters` | List key parameter definitions |
| `querySPDeviceKeyParameterOneDay` | Key params — one day |
| `querySPDeviceKeyParameterMonthPerDay` | Key params — month, per day |
| `querySPDeviceKeyParameterYearPerMonth` | Key params — year, per month |
| `querySPDeviceKeyParameterTotalPerYear` | Key params — yearly totals |
| `querySPDevicesKeyParamOneDay` | Multi-device, one day |
| `querySPDevicesKeyParamMonthPerDay` | Multi-device, month |
| `querySPDevicesKeyParamYearPerMonth` | Multi-device, year |
| `querySPDevicesKeyParamTotalPerYear` | Multi-device, yearly totals |

### Distributor / Sub-accounts (chapter 80)

| Action | Purpose |
|--------|---------|
| `webQueryUsrEs` | List users |
| `editSubAccount` | Edit sub-account |
| `resetSubUsrPassword` | Reset sub-user password |
| `queryAccountGroup` | Account groups |
| `applyBrowsePermission` | Request browse permission |
| `distAddCollectorEs` | Distributor add collector |
| `queryDeviceCtrlFieldForDist` | Control fields for distributor |
| `queryUsrCurveDataOpt` | User chart options |

---

## Suggested Custom UI / Database Flow

```
1. authSource          → store token, secret, expire_at in DB
2. queryAccountInfo    → store user profile
3. queryPlantsInfoEs   → store plants/projects
4. webQueryDeviceEs    → store device list (sn, pn, devcode, devaddr, status)
5. queryCollectorinfoEs→ store collector metadata per pn
6. querySPDeviceLastData → poll every N seconds → upsert latest telemetry
7. webQueryDeviceEnergyFlowEs → poll for dashboard energy-flow widget
8. querySPDeviceKeyParameterOneDay → daily history sync (scheduled)
9. webQueryPlantsWarning / queryDeviceWarning → store alarms
10. updateToken        → refresh before expire
```

### Database tables to consider

- `sessions` — token, secret, expires_at, usr
- `plants` — pid, pname, uid, usr
- `collectors` — pn, alias, method, status, plant_id
- `devices` — sn, pn, devcode, devaddr, devtype, alias, status, brand
- `telemetry_latest` — device_id, gts, pars JSON (bt_/pv_/gd_/by_/sy_)
- `telemetry_history` — device_id, timestamp, field, value, unit
- `energy_flow` — device_id, captured_at, bt/pv/gd/bc status JSON
- `warnings` — device_id, warning_id, message, handled, created_at

---

## Example Request URLs

**Auth (replace sign with computed value):**
```
https://web.dessmonitor.com/public/?sign={sign}&salt={timestamp}&action=authSource&usr=user@example.com&source=1&company-key=<your-company-key>
```

**List devices (after auth):**
```
https://web.dessmonitor.com/public/?sign={sign}&salt={timestamp}&token={token}&action=webQueryDeviceEs&source=1&devtype=2304&page=0&pagesize=15
```

**Latest device data:**
```
https://web.dessmonitor.com/public/?sign={sign}&salt={timestamp}&token={token}&action=querySPDeviceLastData&source=1&pn=<your-collector-pn>&devcode=6513&devaddr=1&sn=<your-device-sn>&i18n=en_US
```

**Energy flow diagram:**
```
https://web.dessmonitor.com/public/?sign={sign}&salt={timestamp}&token={token}&action=webQueryDeviceEnergyFlowEs&source=1&pn=<your-collector-pn>&devcode=6513&devaddr=1&sn=<your-device-sn>
```

---

## Device Types (hex)

| Type | Value |
|------|-------|
| Inverter | 0x0200 |
| Environmental monitor | 0x0300 |
| Smart meter | 0x0400 |
| Combiner box | 0x0500 |
| Camera | 0x0600 |
| Battery | 0x0700 |
| Charger | 0x0800 |
| Energy storage machine | 0x0900 |
| Anti-islanding | 0x0A00 |
| Microinverter | 0x0B00 |

Web portal uses `devtype=2304` (0x0900) for energy storage queries.

---

## Important Key Parameters (telemetry field names)

Common pars returned by `querySPDeviceLastData` and chart APIs:

| Parameter | Description |
|-----------|-------------|
| `OUTPUT_POWER` | Output active power |
| `PV_OUTPUT_POWER` | PV power |
| `GRID_ACTIVE_POWER` | Grid active power |
| `LOAD_ACTIVE_POWER` | Load active power |
| `BATTERY_ACTIVE_POWER` | Battery power |
| `BATTERY_SOC` | State of charge (%) |
| `ENERGY_TODAY` | Daily generation |
| `ENERGY_TOTAL` | Total generation |
| `BATTERY_ENERGY_TODAY_CHARGE` | Daily battery charge |
| `BATTERY_ENERGY_TODAY_DISCHARGE` | Daily battery discharge |
| `LOAD_ENERGY_TODAY` | Daily load consumption |
| `ENERGY_TODAY_TO_GRID` | Daily export to grid |
| `ENERGY_TODAY_FROM_GRID` | Daily import from grid |

---

## Browser Exploration (2026-06-02)

APIs observed while clicking through the device UI for `<your-device-sn>`:

| UI section | API action | What it returns |
|------------|------------|-----------------|
| Home / Energyflow | `webQueryDeviceEnergyFlowEs` | Live flow diagram; battery SOC + charge/discharge direction |
| Home / Energyflow | `querySPDeviceLastData` | Live key snapshot (6 fields on this device) |
| Device info | `queryCollectorinfoEs`, `webQueryGprsCollector` | Collector metadata, SIM/GPRS status |
| Analysis chart | `queryDeviceChartsFieldsEs` | List of chartable metrics (only 3 on this device) |
| Analysis chart | `querySPDeviceKeyParameterOneDay` | Intraday time series for one chart metric |
| Details table | `queryDeviceDataOneDayPaging` | Full protocol history (~177 rows/day) |
| Details table | `queryDeviceParsEs` | Live “important” params (only 3 on this device) |
| Alarm info | `queryDeviceWarning` (expected) | Fault/warning log |
| Debug | `sendCmdToDevice` (expected) | Raw hex command to device |

### What the cloud stores vs what it shows live

**Analysis charts (provider UI)** only expose 3 metrics for this inverter:
- Total solar power generation (`energy_total`)
- Load power (`load_active_power`)
- PV power (`pv_output_power`)

**Battery SOC is NOT chartable** via `querySPDeviceKeyParameterOneDay` — even though `querySPKeyParameters` lists `BT_BATTERY_CAPACITY`, requests for that parameter return `ERR_FORMAT_ERROR`.

**Details history** (`queryDeviceDataOneDayPaging`) *does* include battery data, but sparsely:
- ~177 snapshots/day (~8 min apart, not 5 min)
- 29 protocol columns including: Battery voltage, BMS SOC (%), BMS voltage/current, remaining capacity (Ah), SOH (%), alarms

**Live snapshot** (`querySPDeviceLastData`) — best for high-frequency local polling:
- 6 fields: grid input V/Hz, working state, PV power, **BMS SOC (%)**, load current
- Updates when the device uplinks (same underlying source as portal live view)

**Energy flow** (`webQueryDeviceEnergyFlowEs`) — good secondary poll target:
- `bt_battery_capacity` (SOC %), `battery_active_power`, plus PV/grid/load flow status

**Inverter manual behavior check** (ZD-T Hybrid Off Grid User Manual):
- In mains-priority / battery-priority descriptions, when PV power is lower than load and inverter mode is active, the remaining load is supplied by battery.
- This means **mixed source load supply (PV + battery at the same time) is expected behavior**, not a portal bug.

### Recommended polling strategy (fill gaps the cloud ignores)

```
Primary (every few seconds, store on change):
  querySPDeviceLastData          → SOC, PV, load, grid, state

Secondary (every few seconds, store on change):
  webQueryDeviceEnergyFlowEs     → SOC + charge/discharge direction

Optional voltage sync (every 2 min in poller, `DETAILS_SYNC_INTERVAL_SECONDS`):
  queryDeviceDataOneDayPaging    → Battery voltage + MPPT battery voltage (~8 min cloud rows)

Dashboard reference lines (`GET /api/thresholds`, **on page load only**): reads `queryDeviceCtrlValue` for `lithium_battery_conthigh`, `lithium_battery_contlow`, `bat_power_supply_value`, `bat_mains_power_supply_value` (voltage fields ×2 for 24 V pack). Not polled every 5 s — refresh the browser after changing controls.

Dashboard pack voltage (`GET /api/voltage-history` + `latest` on `/api/summary`): **Pack V** and **Batt V** chart/headline use the newest Details log sample, not telemetry snapshots. SOC/load charts still use `/api/history` (snapshots only when live data hash changes).

Chart time axis uses `server_now` from the API (not the browser clock). Details timestamps are parsed as local time (`DESS_TIMEZONE` or `DESS_UTC_OFFSET_HOURS`, default UTC+7).

Pack voltage backfill: on poller start, `sync_voltage_for_hours` pulls **all Details pages** for each day in `DETAILS_BACKFILL_HOURS` (default 168). Periodic sync re-fetches all of today. Old mis-parsed rows (future `sampled_at`) are purged on sync.
```

Skip for SOC tracking:
- `queryDeviceParsEs` — no battery fields on this device (only 3 power totals)
- `querySPDeviceKeyParameterOneDay` with battery params — not supported
- Analysis chart APIs — power metrics only

---

## Security Notes

- Do **not** commit passwords, tokens, or secrets to git.
- Store credentials in environment variables or a secrets manager.
- Tokens expire (~7 days); implement `updateToken` or re-auth.
- The web login also uses a slider CAPTCHA — programmatic login may need the API path (`authSource` with SHA1 password hash) instead of browser automation.

---

## Device control (`ctrlDevice`)

Write a single control field (equivalent to **Control → Send** in the portal):

```
GET /public/?...&action=ctrlDevice&source=1&pn=...&sn=...&devcode=...&devaddr=...&id={field_id}&val={value}
```

Read back with `queryDeviceCtrlValue` (one `id` per request). List fields with `queryDeviceCtrlField` (`i18n=en_US` or `zh_CN`).

### ZDTID 1.2 kW — duplicate “Lithium battery charging cut-off SOC” (EN i18n bug)

Two different field IDs share the **same English label** in `queryDeviceCtrlField`. Chinese labels show the intended meaning:

| Field ID | English label (wrong duplicate) | Chinese label | Typical value | Meaning |
|----------|-----------------------------------|---------------|---------------|---------|
| `lithium_battery_low_voltage_contlow` | Lithium battery charging cut-off SOC | （预留，不勾选）Reserved — do not check | 100 | Internal / max charge SOC (stop when full); leave alone |
| `lithium_battery_charging_conthigh` | Lithium battery charging cut-off SOC | 锂电池充电截止SOC | 15 | Named charge cut-off parameter in firmware |
| `lithium_battery_charging_contlow` | Lithium battery **discharge** cut-off SOC | 锂电池放电截止SOC | 15 | Discharge floor (correctly labeled in EN) |

Portal row order (Other setting): discharge cut-off → **first** “charging cut-off” (100%, reserved ID) → Frequency → **second** “charging cut-off” (15%, `charging_conthigh`).

Other useful SOC fields on this device:

| Field ID | English name | Role |
|----------|--------------|------|
| `lithium_battery_conthigh` | Lithium battery to inverter SOC | Resume battery/inverter output when SOC ≥ this (was 85%, set to 25% for solar-first) |
| `lithium_battery_contlow` | Lithium battery to mains SOC | Switch to PLN when SOC ≤ this (15%) |
| `lithium_battery_low_voltage_conthigh` | Set the lithium battery low voltage recovery SOC | Recovery hysteresis (20%) |

`generator_mode_setting`: enum `0` = Normal mode, `1` = Generator mode (use Normal when on PLN only).

### ZDTID 1.2 kW — Remote switch (`energy_use_modelph`) does not stick remotely

**Observed on device `<your-device-sn>` (2026-06-03).**

| Field ID | Portal label | Enum |
|----------|--------------|------|
| `energy_use_modelph` | Remote switch setting | `0` = Off state, `1` = Power-on state |

**Symptom:** After other control writes (e.g. `lithium_battery_conthigh` 85→25, `generator_mode_setting`→Normal), portal **Read** showed **Off state** even though the unit was still running (PV/load/SOC telemetry normal). Sending **Power-on state** via Control → **Send** returned success, but **Read from the device** still reported **Off state**. `ctrlDevice` with `val=1` also returned `ERR_NONE` while `queryDeviceCtrlValue` could lag or stay at Off state.

**Not a general write failure:** The same session verified numeric writes work end-to-end — **Lithium battery to inverter SOC** was changed **25 → 30 → Send**, confirmed by portal **Read** and `queryDeviceCtrlValue`, then restored to **25%**.

**Likely cause:** Firmware reflects the **physical remote / local enable** on the inverter; cloud cannot override while hardware reports off. Fix on site: check the unit’s physical remote switch or panel enable, then Control → **Read** — expect **Power-on state**.

**Do not confuse with:** `generator_mode_setting` (Normal vs Generator mode) or work pattern (`work_pattern_contlow` = Inverse priority). Remote switch is a separate row in **Other setting**, between Generator mode and low-voltage recovery SOC.

### ZDTID 1.2 kW — switching behavior in inverter-priority mode (voltage dominates SOC)

**Observed on device `<your-device-sn>` (2026-06-03).**

Key finding from live API reads (`queryDeviceCtrlValue`, `queryDeviceDataOneDayPaging`, `webQueryDeviceEnergyFlowEs`):

- In `work_pattern_contlow = Inverse priority` (`逆变优先`, key `3`), practical source switching follows **voltage thresholds** (`A6/A7`) more strongly than SOC fields.
- SOC settings (`lithium_battery_conthigh = 25`, `lithium_battery_contlow = 15`) stayed unchanged, but did not prevent mains usage when voltage logic favored mains.
- Example: when grid returned around `21:23`, battery was about `25.8V` (pack), SOC about `57%`, and working state switched to **Mains state** with old `A6=13.5` (`27.0V pack`) and `A7=12.6` (`25.2V pack`).
- After tuning to `A6=12.8` (`25.6V pack`) and `A5=12.7`, the unit returned to battery with grid present (grid in standby, battery serving load at about `25.8V`).
- Overnight test adjustment: `A7` lowered from `12.6` to `12.4` (`24.8V pack`) to increase battery usage before mains takeover.

Important related settings:

- Keep grid charging disabled: `charging_gear_setting = C0` and `bat_charging_current = 0` (manual states mains does not charge battery at `0A`).
- Keep voltage ordering valid per manual: `A6 > A7 > A4`, and `A2 > A3 > A6 > A5 > A4`.

Conclusion for this use case (maximize battery use):

- Factory LiFePO4 recommendation (`A6=27.0V pack`, `A7=25.2V pack`) is conservative and can be too high/sticky for night operation with intermittent grid.
- Lower `A6/A7` carefully in small steps and watch for chatter (frequent toggling).
