
      CREATE TABLE IF NOT EXISTS auth_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        secret TEXT NOT NULL,
        expires_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_state (
        device_sn TEXT PRIMARY KEY,
        last_hash TEXT NOT NULL,
        last_gts TEXT,
        last_polled_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_sn TEXT NOT NULL,
        device_gts TEXT,
        data_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        polled_at REAL NOT NULL,
        battery_soc REAL,
        battery_status INTEGER,
        battery_power REAL,
        battery_voltage REAL,
        mppt_battery_voltage REAL,
        pv_power REAL,
        load_current REAL,
        load_power REAL,
        grid_voltage REAL,
        grid_power REAL,
        working_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_sn_time
        ON telemetry_snapshots(device_sn, polled_at DESC);
      CREATE TABLE IF NOT EXISTS battery_voltage_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_sn TEXT NOT NULL,
        sampled_at REAL NOT NULL,
        sampled_at_raw TEXT,
        battery_voltage REAL NOT NULL,
        mppt_battery_voltage REAL,
        working_state TEXT,
        battery_soc REAL,
        UNIQUE(device_sn, sampled_at)
      );
      CREATE INDEX IF NOT EXISTS idx_voltage_sn_time
        ON battery_voltage_readings(device_sn, sampled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_soc
        ON telemetry_snapshots(device_sn, battery_soc, polled_at DESC);
      CREATE TABLE IF NOT EXISTS control_values (
        device_sn TEXT NOT NULL,
        field_id TEXT NOT NULL,
        label TEXT NOT NULL,
        unit TEXT NOT NULL,
        scale REAL NOT NULL,
        raw_value TEXT,
        pack_value REAL,
        source TEXT NOT NULL,
        read_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (device_sn, field_id)
      );
      CREATE TABLE IF NOT EXISTS control_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_sn TEXT NOT NULL,
        field_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        value_before TEXT,
        value_after TEXT,
        details_json TEXT,
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_control_events_device_time
        ON control_events(device_sn, created_at DESC);
      CREATE TABLE IF NOT EXISTS automation_state (
        device_sn TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        target_practical_soc REAL NOT NULL,
        target_time TEXT NOT NULL,
        baseline_a6 REAL NOT NULL,
        baseline_a7 REAL,
        active_override INTEGER NOT NULL,
        override_a6 REAL,
        override_a7 REAL,
        override_value REAL,
        next_check_at REAL,
        last_decision TEXT,
        last_reason TEXT,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS automation_write_budget (
        device_sn TEXT NOT NULL,
        field_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        actor TEXT NOT NULL,
        count INTEGER NOT NULL,
        last_write_at REAL,
        PRIMARY KEY (device_sn, field_id, date_key, actor)
      );

ALTER TABLE telemetry_snapshots ADD COLUMN pv_to_load_kw REAL;
ALTER TABLE telemetry_snapshots ADD COLUMN battery_to_load_kw REAL;
ALTER TABLE telemetry_snapshots ADD COLUMN grid_to_load_kw REAL;
ALTER TABLE telemetry_snapshots ADD COLUMN pv_to_battery_kw REAL;
ALTER TABLE telemetry_snapshots ADD COLUMN grid_to_battery_kw REAL;
ALTER TABLE telemetry_snapshots ADD COLUMN grid_to_battery_reported INTEGER;
ALTER TABLE telemetry_snapshots ADD COLUMN grid_to_battery_unmetered INTEGER;
ALTER TABLE telemetry_snapshots ADD COLUMN battery_flow_unmetered INTEGER;
