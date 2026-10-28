"""Read-only macOS counters. No root access or external packages required."""
import json
import plistlib
import subprocess


def registry(kind):
    try:
        return plistlib.loads(subprocess.check_output(['ioreg', '-a', '-r', '-c', kind], timeout=2))
    except Exception:
        return []


result = {'gpu': [], 'io': None, 'network': None}
for device in registry('IOAccelerator'):
    stats = device.get('PerformanceStatistics', {})
    if not stats:
        continue
    model = device.get('model', 'Apple GPU')
    if isinstance(model, bytes):
        model = model.decode('utf-8', errors='replace').rstrip('\x00')
    result['gpu'].append({'name': model, 'utilizationPercent': stats.get('Device Utilization %'),
                          'usedBytes': stats.get('In use system memory'), 'totalBytes': None,
                          'unifiedMemory': True, 'powerWatts': None, 'temperatureC': None,
                          'memoryControllerPercent': None})
entries = [d['Statistics'] for d in registry('IOBlockStorageDriver') if 'Statistics' in d]
if entries:
    result['io'] = {'read': sum(d.get('Bytes (Read)', 0) for d in entries),
                    'write': sum(d.get('Bytes (Write)', 0) for d in entries)}
try:
    lines = subprocess.check_output(['netstat', '-ibn'], timeout=2, stderr=subprocess.DEVNULL).decode().splitlines()
    columns = lines[0].split()
    received = sent = 0
    seen = set()
    for line in lines[1:]:
        row = line.split()
        if len(row) <= max(columns.index('Ibytes'), columns.index('Obytes')):
            continue
        if row[0] in seen or row[0].startswith('lo') or not row[2].startswith('<Link#'):
            continue
        seen.add(row[0])
        received += int(row[columns.index('Ibytes')])
        sent += int(row[columns.index('Obytes')])
    if seen:
        result['network'] = {'received': received, 'sent': sent}
except Exception:
    pass
print(json.dumps(result))
