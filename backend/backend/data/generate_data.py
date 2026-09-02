import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
random.seed(2909)

MERCHANTS = ["MER_RETAIL_01", "MER_ECOMM_02", "MER_TRAVEL_03", "MER_FOOD_04", "MER_UTIL_05", "MER_DIGITAL_06", "MER_HEALTH_07", "MER_AUTO_08"]
LOCATIONS = ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Pune", "Chennai", "Kolkata", "Ahmedabad"]

# Normal population: exactly ACC_001 ... ACC_099, 337 transactions total.
normal = []
start = datetime(2026, 8, 26, 10, 0, tzinfo=timezone.utc)
counts = {i: 3 for i in range(2, 100)}
for i in range(2, 45):
    counts[i] = 4
assert sum(counts.values()) == 337

idx = 0
for i in range(2, 100):
    account = f"ACC_{i:03d}"
    device = f"DEV_NORMAL_{i:03d}"
    for j in range(counts[i]):
        idx += 1
        target_i = random.randint(1, i - 1)
        target = f"ACC_{target_i:03d}"
        ts = start + timedelta(minutes=idx * 3)
        normal.append({
            "transaction_id": f"TXN_{i:03d}_{j+1}",
            "source_account": account,
            "target_account": target,
            "amount": round(random.uniform(180, 4800), 2),
            "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "device_id": device,
            "ip_address": f"10.10.{(i % 20) + 1}.{10 + (j % 20)}",
            "merchant_id": random.choice(MERCHANTS),
            "location": LOCATIONS[(i + j) % len(LOCATIONS)],
        })

# Suspicious/demo set: 39 transactions using ACC_001..ACC_099 only.
mock = []
base = datetime(2026, 8, 26, 18, 0, tzinfo=timezone.utc)

def add(tid, source, target, amount, minutes, device, ip, merchant, location):
    mock.append({
        "transaction_id": tid,
        "source_account": source,
        "target_account": target,
        "amount": amount,
        "timestamp": (base + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z"),
        "device_id": device,
        "ip_address": ip,
        "merchant_id": merchant,
        "location": location,
    })

# Core fraud ring: 97 -> 98 -> 99 -> 97, plus extra high-value movement.
ring_device = "DEV_HUB_97"
add("FRAUD_097_01", "ACC_097", "ACC_098", 25000, 0, ring_device, "172.16.9.10", "MER_DIGITAL_06", "Mumbai")
add("FRAUD_098_01", "ACC_098", "ACC_099", 24500, 5, ring_device, "172.16.9.11", "MER_DIGITAL_06", "Mumbai")
add("FRAUD_099_01", "ACC_099", "ACC_097", 24000, 10, ring_device, "172.16.9.12", "MER_DIGITAL_06", "Mumbai")
add("FRAUD_097_02", "ACC_097", "ACC_098", 23000, 16, ring_device, "172.16.9.10", "MER_ECOMM_02", "Mumbai")
add("FRAUD_098_02", "ACC_098", "ACC_099", 22500, 21, ring_device, "172.16.9.11", "MER_ECOMM_02", "Mumbai")
add("FRAUD_099_02", "ACC_099", "ACC_097", 22000, 27, ring_device, "172.16.9.12", "MER_ECOMM_02", "Mumbai")
# Secondary device creates cross-account linkage.
for k, (src, dst, amt, mins) in enumerate([
    ("ACC_097", "ACC_098", 18000, 35),
    ("ACC_098", "ACC_099", 17500, 42),
    ("ACC_099", "ACC_097", 17000, 49),
], start=3):
    add(f"FRAUD_RING_{k}", src, dst, amt, mins, ring_device, "172.16.9.13", "MER_TRAVEL_03", "Delhi")

# WATCH / velocity pattern: shared infrastructure + rapid outbound activity, but no circular flow.
watch_device = "DEV_SHARED_80"
watch_edges = [
    ("ACC_080", "ACC_060", 7200, 70), ("ACC_080", "ACC_061", 6900, 75),
    ("ACC_080", "ACC_062", 6400, 80), ("ACC_081", "ACC_063", 6100, 86),
    ("ACC_082", "ACC_064", 5900, 92), ("ACC_083", "ACC_065", 5600, 98),
]
for i, (src, dst, amt, mins) in enumerate(watch_edges, start=1):
    add(f"WATCH_80_{i:02d}", src, dst, amt, mins, watch_device, "172.18.8.20", "MER_RETAIL_01", "Pune")

# Mule/pass-through pattern: funds arrive from higher-numbered accounts and leave toward lower-numbered accounts.
mule_device = "DEV_MULE_70"
mule_edges = [
    ("ACC_073", "ACC_070", 15000, 110), ("ACC_075", "ACC_070", 14500, 112),
    ("ACC_077", "ACC_070", 13500, 114), ("ACC_079", "ACC_070", 12500, 116),
    ("ACC_070", "ACC_060", 11800, 120), ("ACC_070", "ACC_061", 11200, 123),
    ("ACC_070", "ACC_062", 10800, 126), ("ACC_074", "ACC_071", 13200, 128),
    ("ACC_076", "ACC_071", 12100, 131), ("ACC_078", "ACC_071", 11500, 134),
    ("ACC_071", "ACC_063", 10200, 138),
]
for i, (src, dst, amt, mins) in enumerate(mule_edges, start=1):
    add(f"MULE_FLOW_{i:02d}", src, dst, amt, mins, mule_device, "172.20.7.70", "MER_AUTO_08", "Bengaluru")

# Additional moderate flows, still directional from higher to lower IDs.
extra_edges = [
    ("ACC_050", "ACC_040", 8200, 150), ("ACC_051", "ACC_041", 7900, 156),
    ("ACC_052", "ACC_042", 7600, 162), ("ACC_053", "ACC_043", 7300, 168),
    ("ACC_055", "ACC_045", 6800, 174), ("ACC_056", "ACC_046", 6500, 180),
    ("ACC_058", "ACC_048", 6200, 186), ("ACC_059", "ACC_049", 6000, 192),
    ("ACC_061", "ACC_051", 5700, 198), ("ACC_062", "ACC_052", 5400, 204),
    ("ACC_064", "ACC_054", 5100, 210), ("ACC_065", "ACC_055", 4800, 216),
    ("ACC_067", "ACC_057", 4500, 222),
]
for i, (src, dst, amt, mins) in enumerate(extra_edges, start=1):
    add(f"PATTERN_FLOW_{i:02d}", src, dst, amt, mins, f"DEV_PATTERN_{i:02d}", "172.22.6.30", MERCHANTS[i % len(MERCHANTS)], LOCATIONS[i % len(LOCATIONS)])

assert len(mock) == 39
assert all(1 <= int(t["source_account"].split("_")[1]) <= 99 for t in mock)
assert all(1 <= int(t["target_account"].split("_")[1]) <= 99 for t in mock)

(ROOT / "normal_transactions.json").write_text(json.dumps(normal, indent=2), encoding="utf-8")
(ROOT / "mock_transactions.json").write_text(json.dumps(mock, indent=2), encoding="utf-8")
print(f"normal={len(normal)} mock={len(mock)} total={len(normal)+len(mock)}")
