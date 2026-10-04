#!/usr/bin/env python3
"""Solar-only release validation and cutover. Run on utf-sh as root.

Usage: rust-vps-release.py RELEASE {audit,validate,cutover,verify,rollback}
RELEASE must be rust-YYYYMMDDTHHMMSSZ under /opt/solar-system/releases.
The build script must finish before validate. Cutover requires its saved report.
Rollback restores service commands and keeps the current compatible databases.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/opt/solar-system')
DATA = ROOT / 'data'
UNITS = ['solar-api.service', 'solar-poller.service', 'solar-db-backup.service']
DROPIN = '30-rust-backend.conf'
TABLES = ['telemetry_snapshots', 'battery_voltage_readings', 'device_state',
          'control_values', 'control_events', 'automation_state', 'automation_write_budget']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def solar(args, **kwargs):
    return command(['runuser', '-u', 'solar', '--', *map(str, args)], **kwargs)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def private_dir(path):
    path.mkdir(mode=0o700)
    uid = int(command(['id', '-u', 'solar']))
    gid = int(command(['id', '-g', 'solar']))
    os.chown(path, uid, gid)


def show(unit, prop):
    return command(['systemctl', 'show', unit, '-p', prop, '--value'])


def get_json(port, path, method='GET', body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=body, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def protected_state():
    state = {'services': {}, 'sites': {}, 'frontend': {}, 'base_units': {}}
    for unit in ['nginx.service', 'kebun.service']:
        state['services'][unit] = {key: show(unit, key) for key in [
            'ActiveState', 'SubState', 'MainPID', 'NRestarts', 'ExecMainStartTimestampMonotonic']}
    for path in sorted(Path('/etc/nginx/sites-enabled').iterdir()):
        state['sites'][path.name] = {'target': str(path.resolve()), 'sha256': digest(path)}
    for path in sorted((ROOT / 'app/dist').rglob('*')):
        if path.is_file():
            state['frontend'][str(path.relative_to(ROOT / 'app/dist'))] = digest(path)
    for unit in UNITS:
        state['base_units'][unit] = digest(Path('/etc/systemd/system') / unit)
    state['environment_sha256'] = digest(ROOT / '.env')
    state['kebun_current'] = str(Path('/opt/kebun/current').resolve())
    return state


def preflight():
    require(socket.gethostname() == 'utf-sh', 'Refusing another host')
    require(os.getuid() == 0, 'Run as root on the verified host')
    for path in [ROOT, ROOT / 'app', DATA, ROOT / '.env']:
        require(path.resolve() == path, f'Refusing redirected path: {path}')
    for unit in UNITS[:2]:
        require(show(unit, 'User') == 'solar', f'Wrong identity: {unit}')
        require(show(unit, 'WorkingDirectory') == str(ROOT / 'app'), f'Wrong working directory: {unit}')
        require(show(unit, 'UMask') == '0077', f'Wrong umask: {unit}')
        require(show(unit, 'TimeoutStopUSec') == '5min', f'Wrong shutdown window: {unit}')
    command(['systemctl', 'is-active', '--quiet', 'solar-api.service', 'solar-poller.service',
             'solar-db-backup.timer', 'nginx.service', 'kebun.service'])
    command(['nginx', '-t'])
    command(['curl', '-kfsS', '--max-time', '8', '-o', '/dev/null', '--resolve',
             'kebun.utf.sh:443:127.0.0.1', 'https://kebun.utf.sh/'])
    require(get_json(43871, '/api/ready')[0] == 200, 'Solar readiness failed')
    for name in ['solar.db', 'solar-control.db']:
        path = DATA / name
        require(path.is_file() and path.resolve() == path, f'Invalid database: {path}')
        require(path.stat().st_mode & 0o777 == 0o600, f'Wrong database mode: {path}')
    require(shutil.disk_usage(ROOT).free > 2 * 1024**3, 'Less than 2 GiB free')


def db_state(telemetry, control):
    # This command is invoked as solar, including for read-only production checks.
    result = {}
    for role, path in [('telemetry', telemetry), ('control', control)]:
        require(path.is_file(), 'Database must exist')
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')
            checks = [row[0] for row in db.execute('PRAGMA quick_check')]
            require(checks == ['ok'], f'{role} quick_check failed')
            schema = list(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
            counts = {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in TABLES}
            state = {'quick_check': 'ok', 'counts': counts,
                     'schema_sha256': hashlib.sha256(json.dumps(schema).encode()).hexdigest(),
                     'inode': path.stat().st_ino}
            if role == 'telemetry':
                state['last_poll'] = db.execute('SELECT MAX(last_polled_at) FROM device_state').fetchone()[0]
                state['first_snapshot'] = db.execute('SELECT MIN(polled_at) FROM telemetry_snapshots').fetchone()[0]
            else:
                state['automation'] = list(db.execute('SELECT enabled,target_practical_soc,target_time,baseline_a6,baseline_a7,active_override,override_a6,override_a7 FROM automation_state ORDER BY device_sn'))
                state['budget_sha256'] = hashlib.sha256(json.dumps(list(db.execute('SELECT * FROM automation_write_budget ORDER BY device_sn,field_id,date_key,actor'))).encode()).hexdigest()
            result[role] = state
    return result


def inspect(telemetry=DATA / 'solar.db', control=DATA / 'solar-control.db'):
    return json.loads(solar(['python3', Path(__file__).resolve(), release.name, 'db-state',
                             '--telemetry', telemetry, '--control', control]))


def backup(destination, legacy=False):
    private_dir(destination)
    if legacy:
        output = solar(['/usr/bin/node', '--import', 'tsx', ROOT / 'app/server/backup.ts',
                        '--destination', destination, '--keep', '14'], cwd=ROOT / 'app')
    else:
        output = solar([release / 'bin/solar-backend', '--allow-production-data',
                        '--telemetry-db', DATA / 'solar.db', '--control-db', DATA / 'solar-control.db',
                        'backup', '--destination', destination, '--keep', '14'])
    manifests = list(destination.glob('manifest-*.json'))
    require(len(manifests) == 1, 'Expected one complete private backup set')
    manifest = json.loads(manifests[0].read_text())
    sources = {}
    for entry in manifest['files']:
        name = entry['filename']
        require(Path(name).name == name, 'Invalid backup filename')
        path = destination / name
        require(path.is_file() and not path.is_symlink(), 'Missing backup file')
        require(path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'], 'Backup checksum mismatch')
        sources[entry['role']] = path
    require(set(sources) == {'telemetry', 'control'}, 'Incomplete paired backup')
    checked = inspect(sources['telemetry'], sources['control'])
    return {'manifest': str(manifests[0]), 'databases': checked}, sources


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items() if key not in {
            'server_now', 'age_seconds', 'desired_practical_soc_now', 'target_voltage',
            'target_a6', 'target_a7', 'target_band_capped'}}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return value


def difference(a, b, path='$'):
    if isinstance(a, (float, int)) and isinstance(b, (float, int)):
        return None if math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-8) else path
    if type(a) is not type(b):
        return path
    if isinstance(a, dict):
        if set(a) != set(b):
            return path + '.keys'
        for key in a:
            found = difference(a[key], b[key], path + '.' + key)
            if found:
                return found
    elif isinstance(a, list):
        if len(a) != len(b):
            return path + '.length'
        for i, pair in enumerate(zip(a, b)):
            found = difference(*pair, path + f'[{i}]')
            if found:
                return found
    elif a != b:
        return path
    return None


def port_available(port):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))


def validate_live_poller(sources, sandbox):
    # Only telemetry reads are enabled. Inverter write permission is absent.
    telemetry = sandbox / 'live-telemetry.db'
    shutil.copyfile(sources['telemetry'], telemetry)
    os.chown(telemetry, int(command(['id', '-u', 'solar'])), int(command(['id', '-g', 'solar'])))
    os.chmod(telemetry, 0o600)
    before = inspect(telemetry, sandbox / 'control.db')
    args = ['runuser', '-u', 'solar', '--', 'env', 'POLL_INTERVAL_SECONDS=60',
            'DETAILS_SYNC_INTERVAL_SECONDS=86400', 'DETAILS_BACKFILL_ON_START=0',
            str(release / 'bin/solar-backend'), '--env-file', str(ROOT / '.env'),
            '--telemetry-db', str(telemetry), '--control-db', str(sandbox / 'control.db'),
            '--live-device', 'poller']
    with (release / 'poller-validation.log').open('x') as log:
        os.chmod(log.name, 0o600)
        child = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
        try:
            for attempt in range(60):
                require(child.poll() is None, 'Validation poller exited; inspect private log')
                time.sleep(2)
                after = inspect(telemetry, sandbox / 'control.db')
                if after['telemetry']['last_poll'] > before['telemetry']['last_poll']:
                    require(time.time() - after['telemetry']['last_poll'] < 30, 'Validation poll is stale')
                    print('Rust DESS read and copied-database persistence passed', flush=True)
                    return {'last_poll': after['telemetry']['last_poll'], 'quick_check': 'ok'}
            raise RuntimeError('Rust poller did not persist a successful live read within 120 seconds')
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=180)


def validate():
    preflight()
    require(not (release / 'validation.json').exists(), 'Validation already exists; choose a new release for another attempt')
    binary = release / 'bin/solar-backend'
    require(binary.is_file() and not binary.is_symlink(), 'Build the Linux binary first')
    baseline = protected_state()
    before = inspect()
    saved, sources = backup(release / 'validation-backup', legacy=True)
    sandbox = release / 'validation'
    private_dir(sandbox)
    for role in ['telemetry', 'control']:
        shutil.copyfile(sources[role], sandbox / f'{role}.db')
        os.chown(sandbox / f'{role}.db', int(command(['id', '-u', 'solar'])), int(command(['id', '-g', 'solar'])))
        os.chmod(sandbox / f'{role}.db', 0o600)
    shutil.copyfile(sandbox / 'control.db', sandbox / 'legacy-control.db')
    os.chown(sandbox / 'legacy-control.db', int(command(['id', '-u', 'solar'])), int(command(['id', '-g', 'solar'])))
    os.chmod(sandbox / 'legacy-control.db', 0o600)
    guard = release / 'no-network.mjs'
    guard.write_text('globalThis.fetch = async () => { throw new Error("Network disabled during copied-database validation"); };\n')
    guard.chmod(0o644)
    for port in [43873, 43874]:
        port_available(port)
    rust_args = ['runuser', '-u', 'solar', '--', str(binary), '--env-file', str(ROOT / '.env'),
                 '--telemetry-db', str(sandbox / 'telemetry.db'), '--control-db', str(sandbox / 'control.db'),
                 'api', '--port', '43873']
    legacy_args = ['runuser', '-u', 'solar', '--', 'env',
                   'DESS_DB_PATH=' + str(sandbox / 'telemetry.db'),
                   'DESS_CONTROL_DB_PATH=' + str(sandbox / 'legacy-control.db'),
                   'DESS_DASHBOARD_PORT=43874', 'AUTOMATION_CHECK_INTERVAL_SECONDS=86400',
                   '/usr/bin/node', '--import', 'tsx', '--import', str(guard), str(ROOT / 'app/server/index.ts')]
    children = []
    logs = []
    compared = []
    try:
        for name, args in [('rust', rust_args), ('legacy', legacy_args)]:
            log = (release / f'{name}-validation.log').open('x')
            os.chmod(log.name, 0o600)
            logs.append(log)
            children.append(subprocess.Popen(args, cwd=ROOT / 'app', stdout=log, stderr=log, start_new_session=True))
        for port in [43873, 43874]:
            for attempt in range(30):
                require(all(child.poll() is None for child in children), 'Validation API exited; inspect private logs')
                try:
                    require(get_json(port, '/api/config')[0] == 200, 'Validation config failed')
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.5)
            else:
                raise RuntimeError('Validation API did not start')
        paths = ['/api/config', '/api/latest', '/api/history?hours=1',
                 '/api/history?hours=24', '/api/history?hours=168&max_points=200',
                 '/api/history?hours=168', '/api/snapshots?limit=5',
                 '/api/voltage-history?hours=168', '/api/daily?days=7',
                 '/api/daily?days=30&date=2026-09-29', '/api/summary',
                 '/api/controls', '/api/control-log?limit=80', '/api/automation', '/api/ready']
        for path in paths:
            rs, rv = get_json(43873, path)
            ts, tv = get_json(43874, path)
            # Control copies are separate; the exposed config must retain its path keys.
            if path == '/api/config':
                rv['control_db_path'] = tv['control_db_path']
            require(rs == ts, f'Status mismatch on {path}')
            found = difference(normalized(rv), normalized(tv))
            require(found is None, f'API mismatch on {path} at {found}')
            compared.append({'path': path, 'status': rs})
            print('Compared ' + path, flush=True)
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        for log in logs:
            log.close()
    live_poller = validate_live_poller(sources, sandbox)
    require(protected_state() == baseline, 'Protected state changed during validation')
    report = {'release': release.name, 'binary_sha256': digest(binary), 'protected': baseline,
              'production_before': before, 'backup': saved, 'api_comparisons': compared,
              'live_poller': live_poller, 'validated_at': time.time()}
    save(release / 'validation.json', report)
    print(json.dumps({'status': 'validated', 'comparisons': len(compared), 'backup': saved['manifest']}))


def dropin_paths():
    return [Path('/etc/systemd/system') / (unit + '.d') / DROPIN for unit in UNITS]


def install_overrides():
    binary = release / 'bin/solar-backend'
    base = f'{binary} --allow-production-data --telemetry-db {DATA}/solar.db --control-db {DATA}/solar-control.db'
    contents = [f'[Service]\nExecStart=\nExecStart={base} --live-device --allow-device-writes api --port 43871\n',
                f'[Service]\nExecStart=\nExecStart={base} --live-device poller\n',
                f'[Service]\nExecStart=\nExecStart={base} backup --destination {ROOT}/backups --keep 14\n']
    for path, content in zip(dropin_paths(), contents):
        path.parent.mkdir(mode=0o755, exist_ok=True)
        require(path.parent.resolve() == path.parent, 'Redirected systemd directory')
        pending = path.with_name(DROPIN + '.' + release.name + '.pending')
        with pending.open('x') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        pending.chmod(0o644)
        os.replace(pending, path)
    command(['systemctl', 'daemon-reload'])
    command(['systemd-analyze', 'verify', *UNITS])
    for unit in UNITS:
        require(str(binary) in show(unit, 'ExecStart'), 'Rust service command did not load')


def restore_commands():
    previous_file = release / 'previous-overrides.json'
    previous = json.loads(previous_file.read_text()) if previous_file.exists() else {unit: None for unit in UNITS}
    for unit, path in zip(UNITS, dropin_paths()):
        require(path.parent.resolve() == path.parent and not path.is_symlink(), 'Redirected systemd override')
        current = path.read_text() if path.exists() else None
        require(current == previous[unit] or (current and str(release / 'bin/solar-backend') in current),
                'Refusing another release override')
    command(['systemctl', 'stop', 'solar-api.service', 'solar-poller.service'])
    for unit, path in zip(UNITS, dropin_paths()):
        if previous[unit] is None:
            if path.exists():
                path.unlink()
        elif not path.exists() or path.read_text() != previous[unit]:
            pending = path.with_name(DROPIN + '.' + release.name + '.rollback')
            with pending.open('x') as stream:
                stream.write(previous[unit])
                stream.flush()
                os.fsync(stream.fileno())
            pending.chmod(0o644)
            os.replace(pending, path)
    command(['systemctl', 'daemon-reload'])
    command(['systemctl', 'start', 'solar-poller.service', 'solar-api.service'])


def wait_ready(minimum_poll=None):
    consecutive = 0
    for attempt in range(45):
        try:
            status, value = get_json(43871, '/api/ready')
            fresh_poll = minimum_poll is None or value['checks']['telemetry']['last_polled_at'] > minimum_poll
            consecutive = consecutive + 1 if status == 200 and value['ready'] and fresh_poll else 0
            if consecutive >= 3:
                return
        except (OSError, urllib.error.URLError):
            consecutive = 0
        time.sleep(2)
    raise RuntimeError('Solar did not become ready within 90 seconds')


def verify():
    report = json.loads((release / 'validation.json').read_text())
    require(protected_state() == report['protected'], 'Protected state differs from validated baseline')
    stopped_file = release / 'stopped-databases.json'
    stopped = json.loads(stopped_file.read_text()) if stopped_file.exists() else None
    # An unchanged inverter response commits its heartbeat once per minute.
    wait_ready(stopped['telemetry']['last_poll'] if stopped else None)
    for unit in UNITS[:2]:
        require(show(unit, 'ActiveState') == 'active' and show(unit, 'NRestarts') == '0', 'Service restart or failure')
        pid = int(show(unit, 'MainPID'))
        require(Path(f'/proc/{pid}/exe').resolve() == release / 'bin/solar-backend', 'Wrong running executable')
    command(['nginx', '-t'])
    command(['curl', '-kfsS', '--max-time', '8', '-o', '/dev/null', '--resolve',
             'kebun.utf.sh:443:127.0.0.1', 'https://kebun.utf.sh/'])
    command(['curl', '-fsS', '--max-time', '8', '-o', '/dev/null', '-H', 'Host: solar.utf.sh',
             'http://127.0.0.1/api/ready'])
    status = command(['curl', '-sS', '-I', '--connect-timeout', '5', '--max-time', '20',
                      '-o', '/dev/null', '-w', '%{http_code}', 'https://solar.utf.sh'])
    require(status == '302', 'Unexpected public Cloudflare Access response')
    state = inspect()
    if stopped:
        for role in ['telemetry', 'control']:
            require(state[role]['inode'] == stopped[role]['inode'], 'Live database file was replaced')
            require(state[role]['schema_sha256'] == stopped[role]['schema_sha256'], 'Live schema changed')
        for table in ['telemetry_snapshots', 'battery_voltage_readings']:
            require(state['telemetry']['counts'][table] >= stopped['telemetry']['counts'][table], 'Telemetry history decreased')
        require(state['control']['automation'] == stopped['control']['automation'], 'Automation settings changed')
        require(state['telemetry']['last_poll'] > stopped['telemetry']['last_poll'], 'Rust poller has not persisted fresh telemetry')
    print(json.dumps({'status': 'healthy', 'release': release.name, 'databases': state, 'public_status': status}))
    return state


def smoke():
    results = []
    for path in ['/api/config', '/api/latest', '/api/history?hours=24&max_points=200',
                 '/api/history?hours=168', '/api/voltage-history?hours=24',
                 '/api/daily?days=7', '/api/summary', '/api/controls',
                 '/api/control-log?limit=10', '/api/automation', '/api/thresholds']:
        start = time.perf_counter()
        status, payload = get_json(43871, path)
        require(status == 200 and isinstance(payload, dict), f'Live endpoint failed: {path}')
        results.append({'path': path, 'status': status, 'elapsed_ms': round((time.perf_counter() - start) * 1000, 2)})
    # These are inverter reads only; no write/automation-evaluate endpoint is called.
    for field in ['bat_power_supply_value', 'bat_mains_power_supply_value']:
        status, payload = get_json(43871, '/api/controls/' + field + '/read', method='POST', body=b'{}')
        require(status == 200 and payload.get('control'), 'Live inverter read failed')
        results.append({'path': '/api/controls/' + field + '/read', 'status': status})
    state = verify()
    manifests = sorted((ROOT / 'backups').glob('manifest-*.json'))
    require(len(manifests) == 14, 'Expected fourteen complete retained backup sets')
    manifest = json.loads(manifests[-1].read_text())
    for entry in manifest['files']:
        require(Path(entry['filename']).name == entry['filename'], 'Invalid backup name')
        require(digest(ROOT / 'backups' / entry['filename']) == entry['sha256'], 'Published backup checksum mismatch')
    report = {'checked_at': time.time(), 'endpoints': results, 'databases': state,
              'latest_backup_manifest': str(manifests[-1]), 'retained_backup_sets': len(manifests)}
    save(release / 'live-smoke.json', report)
    print(json.dumps({'status': 'smoke-passed', 'endpoints': results, 'backup_sets': len(manifests)}))


def cutover():
    preflight()
    report = json.loads((release / 'validation.json').read_text())
    require(time.time() - report['validated_at'] < 3600, 'Validation is older than one hour')
    require(digest(release / 'bin/solar-backend') == report['binary_sha256'], 'Binary changed after validation')
    require(protected_state() == report['protected'], 'Protected state changed after validation')
    previous = {}
    for unit, path in zip(UNITS, dropin_paths()):
        require(path.parent.resolve() == path.parent and not path.is_symlink(), 'Redirected systemd override')
        require(not path.exists() or path.stat().st_uid == 0, 'Override must be root-owned')
        previous[unit] = path.read_text() if path.exists() else None
        if previous[unit] is not None:
            require(re.search(r'/opt/solar-system/releases/rust-\d{8}T\d{6}Z/bin/solar-backend', previous[unit]),
                    'Existing override is not a Solar release')
    require(show('solar-db-backup.service', 'ActiveState') == 'inactive', 'Backup job is active')
    save(release / 'previous-overrides.json', previous)
    saved, _ = backup(release / 'precutover-backup')
    save(release / 'precutover-backup.json', saved)
    stopped = False
    try:
        print('Stopping only Solar API and poller; waiting for graceful shutdown', flush=True)
        stopped = True
        command(['systemctl', 'stop', 'solar-api.service', 'solar-poller.service'])
        for unit in UNITS[:2]:
            require(show(unit, 'ActiveState') == 'inactive', 'Legacy writer did not stop')
            require(show(unit, 'Result') == 'success', 'Legacy shutdown failed')
        stable = inspect()
        save(release / 'stopped-databases.json', stable)
        # Both writers are now stopped, so this is the exact pair at cutover.
        final_backup, _ = backup(release / 'stopped-backup')
        save(release / 'stopped-backup.json', final_backup)
        for role in ['telemetry', 'control']:
            for key in ['counts', 'schema_sha256']:
                require(final_backup['databases'][role][key] == stable[role][key], 'Stopped backup differs from live database')
        require(protected_state() == report['protected'], 'Protected state changed before activation')
        install_overrides()
        command(['systemctl', 'start', 'solar-poller.service', 'solar-api.service'])
        print('Rust services started; verifying fresh telemetry and shared services', flush=True)
        state = verify()
        command(['systemctl', 'start', 'solar-db-backup.service'])
        require(show('solar-db-backup.service', 'Result') == 'success', 'Rust backup service failed')
        save(release / 'cutover.json', {'activated_at': time.time(), 'state': state, 'backup_service_result': 'success'})
    except BaseException:
        if stopped:
            print('Cutover verification failed; restoring previous service commands', file=sys.stderr, flush=True)
            restore_commands()
            wait_ready()
            require(protected_state() == report['protected'], 'Protected state differs after rollback')
        raise


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('release')
parser.add_argument('action', choices=['audit', 'validate', 'cutover', 'verify', 'smoke', 'rollback', 'db-state'])
parser.add_argument('--telemetry', type=Path)
parser.add_argument('--control', type=Path)
args = parser.parse_args()
require(re.fullmatch(r'rust-\d{8}T\d{6}Z', args.release), 'Invalid release name')
release = ROOT / 'releases' / args.release
require(release.resolve() == release and release.is_dir(), 'Invalid release directory')
if args.action == 'db-state':
    require(os.getuid() == int(command(['id', '-u', 'solar'])), 'Database inspection must run as solar')
    require(args.telemetry and args.control, 'Select explicit database paths')
    for path in [args.telemetry, args.control]:
        require(path.resolve() == path and (path.parent == DATA or path.is_relative_to(release)), 'Invalid inspection path')
    print(json.dumps(db_state(args.telemetry, args.control)))
else:
    require(os.getuid() == 0 and socket.gethostname() == 'utf-sh', 'Run as root on utf-sh')
    if args.action == 'audit':
        preflight()
        print(json.dumps({'status': 'healthy', 'databases': inspect(), 'protected': protected_state()}))
    elif args.action == 'validate':
        validate()
    elif args.action == 'cutover':
        cutover()
    elif args.action == 'verify':
        verify()
    elif args.action == 'smoke':
        smoke()
    elif args.action == 'rollback':
        restore_commands()
        wait_ready()
        print('Previous service commands restored; current databases retained')
