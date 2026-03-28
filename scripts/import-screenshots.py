import json, random, string, datetime

raw = [
  # Batch 1
  {"timestamp":"2026-03-08T12:15:16Z","session":10,"weekly_all":2,"weekly_sonnet":0,"resets_in_min":44},
  {"timestamp":"2026-03-08T14:32:13Z","session":7,"weekly_all":4,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T15:41:37Z","session":11,"weekly_all":4,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T15:54:59Z","session":14,"weekly_all":5,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T16:29:13Z","session":17,"weekly_all":5,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T16:46:21Z","session":23,"weekly_all":6,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T17:18:35Z","session":25,"weekly_all":6,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T18:52:45Z","session":53,"weekly_all":10,"weekly_sonnet":0,"resets_in_min":7},
  {"timestamp":"2026-03-08T19:14:30Z","session":3,"weekly_all":10,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T19:21:33Z","session":5,"weekly_all":11,"weekly_sonnet":0,"resets_in_min":None},
  # Batch 2
  {"timestamp":"2026-03-08T19:37:18Z","session":16,"weekly_all":12,"weekly_sonnet":0,"resets_in_min":None},
  {"timestamp":"2026-03-08T19:43:31Z","session":19,"weekly_all":13,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-08T20:05:27Z","session":32,"weekly_all":14,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-08T22:55:20Z","session":57,"weekly_all":18,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-08T23:08:45Z","session":59,"weekly_all":18,"weekly_sonnet":1,"resets_in_min":51},
  {"timestamp":"2026-03-09T11:20:33Z","session":3,"weekly_all":18,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-09T12:22:23Z","session":12,"weekly_all":19,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-09T12:54:40Z","session":20,"weekly_all":20,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-09T13:19:10Z","session":26,"weekly_all":21,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-09T13:53:21Z","session":41,"weekly_all":23,"weekly_sonnet":1,"resets_in_min":None},
  # Batch 3
  {"timestamp":"2026-03-09T20:48:18Z","session":30,"weekly_all":30,"weekly_sonnet":1,"resets_in_min":12},
  {"timestamp":"2026-03-10T08:20:58Z","session":0,"weekly_all":30,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T09:14:59Z","session":14,"weekly_all":32,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T10:02:13Z","session":27,"weekly_all":34,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T10:26:08Z","session":32,"weekly_all":34,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T11:05:17Z","session":40,"weekly_all":35,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T12:00:19Z","session":53,"weekly_all":37,"weekly_sonnet":1,"resets_in_min":59},
  {"timestamp":"2026-03-10T13:53:08Z","session":4,"weekly_all":38,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T15:31:39Z","session":25,"weekly_all":41,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-10T17:01:37Z","session":34,"weekly_all":42,"weekly_sonnet":1,"resets_in_min":58},
  # Batch 4
  {"timestamp":"2026-03-11T08:07:15Z","session":0,"weekly_all":42,"weekly_sonnet":1,"resets_in_min":None},
  {"timestamp":"2026-03-11T09:29:47Z","session":27,"weekly_all":45,"weekly_sonnet":2,"resets_in_min":None},
  {"timestamp":"2026-03-11T12:59:09Z","session":61,"weekly_all":50,"weekly_sonnet":2,"resets_in_min":0},
  {"timestamp":"2026-03-17T09:29:59Z","session":0,"weekly_all":14,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T10:28:26Z","session":5,"weekly_all":15,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T11:18:02Z","session":12,"weekly_all":15,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T12:19:08Z","session":17,"weekly_all":16,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T12:41:36Z","session":20,"weekly_all":17,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T13:02:32Z","session":23,"weekly_all":17,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T13:37:20Z","session":29,"weekly_all":18,"weekly_sonnet":4,"resets_in_min":None},
  # Batch 5
  {"timestamp":"2026-03-17T15:03:57Z","session":6,"weekly_all":19,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T16:53:01Z","session":21,"weekly_all":21,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T17:57:04Z","session":25,"weekly_all":21,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-17T18:59:00Z","session":31,"weekly_all":22,"weekly_sonnet":4,"resets_in_min":1},
  {"timestamp":"2026-03-17T20:34:57Z","session":0,"weekly_all":22,"weekly_sonnet":4,"resets_in_min":None},
  {"timestamp":"2026-03-18T01:29:43Z","session":7,"weekly_all":26,"weekly_sonnet":6,"resets_in_min":None},
  {"timestamp":"2026-03-18T01:41:00Z","session":10,"weekly_all":27,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-18T07:38:41Z","session":0,"weekly_all":27,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-18T08:36:02Z","session":5,"weekly_all":27,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-18T10:22:55Z","session":15,"weekly_all":29,"weekly_sonnet":7,"resets_in_min":None},
  # Batch 6
  {"timestamp":"2026-03-18T11:14:07Z","session":40,"weekly_all":32,"weekly_sonnet":7,"resets_in_min":45},
  {"timestamp":"2026-03-18T12:02:26Z","session":1,"weekly_all":33,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-18T12:55:10Z","session":15,"weekly_all":34,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-18T13:03:22Z","session":15,"weekly_all":34,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-18T15:20:02Z","session":32,"weekly_all":37,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-19T09:07:10Z","session":0,"weekly_all":37,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-19T12:45:40Z","session":13,"weekly_all":38,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-19T21:03:19Z","session":0,"weekly_all":40,"weekly_sonnet":7,"resets_in_min":None},
  {"timestamp":"2026-03-20T00:05:53Z","session":17,"weekly_all":42,"weekly_sonnet":7,"resets_in_min":None},
]

def rand_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=5))

CET_OFFSET = datetime.timezone(datetime.timedelta(hours=1))

def local_to_utc(ts_local):
    # ts_local is CET (UTC+1), convert to UTC
    dt = datetime.datetime.fromisoformat(ts_local.replace('Z', '')).replace(tzinfo=CET_OFFSET)
    return dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def ts_to_ms(ts):
    dt = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
    return int(dt.timestamp() * 1000)

def make_entry(ts_local, pct, scope, resets_in_min=None):
    ts = local_to_utc(ts_local)
    ms = ts_to_ms(ts)
    window_start = None
    if scope == "5h" and resets_in_min is not None:
        dt = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).replace(tzinfo=datetime.timezone.utc)
        window_start_dt = dt - datetime.timedelta(minutes=300 - resets_in_min)
        window_start = window_start_dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
    return {
        "id": f"cal_{ms}_{rand_id()}",
        "timestamp": ts,
        "reportedPct": pct,
        "scope": scope,
        "tokens": None,
        "cost": None,
        "windowId": None,
        "windowStart": window_start,
        "peakStatus": None,
        "promoMultiplier": None,
        "source": "screenshot"
    }

new_entries = []
for r in raw:
    new_entries.append(make_entry(r["timestamp"], r["session"], "5h", r["resets_in_min"]))
    new_entries.append(make_entry(r["timestamp"], r["weekly_all"], "weekly-all"))
    new_entries.append(make_entry(r["timestamp"], r["weekly_sonnet"], "weekly-sonnet"))


with open("H:/_Dev/repos/products/ClaudeUsage/data/calibrations.json") as f:
    existing = json.load(f)

combined = existing + new_entries
combined.sort(key=lambda x: x["timestamp"])

with open("H:/_Dev/repos/products/ClaudeUsage/data/calibrations.json", "w") as f:
    json.dump(combined, f, indent=2)

print(f"Dodano {len(new_entries)} wpisow. Lacznie: {len(combined)}")
