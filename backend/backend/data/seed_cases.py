import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from graph_builder import load_graph_data, analyze_account

G = load_graph_data()
settings = {"high_threshold":65,"watch_threshold":35}
accounts = ["ACC_097","ACC_098","ACC_099","ACC_080","ACC_081","ACC_070","ACC_071","ACC_072","ACC_050","ACC_051","ACC_060","ACC_065","ACC_075","ACC_010","ACC_020","ACC_030","ACC_040","ACC_055"]
statuses = ["CLOSED","INVESTIGATING","OPEN","CLOSED","OPEN","INVESTIGATING","OPEN","CLOSED","OPEN","CLOSED","OPEN","CLOSED","INVESTIGATING","CLOSED","OPEN","CLOSED","OPEN","CLOSED"]
priorities = ["HIGH","HIGH","CRITICAL","HIGH","HIGH","HIGH","HIGH","MEDIUM","MEDIUM","MEDIUM","MEDIUM","LOW","HIGH","LOW","MEDIUM","LOW","MEDIUM","LOW"]
base = datetime(2026,8,27,9,0,tzinfo=timezone.utc)
case_list=[]
for idx,(account,status,priority) in enumerate(zip(accounts,statuses,priorities), start=1):
    r=analyze_account(G,account)
    now=(base+timedelta(hours=idx)).isoformat().replace('+00:00','Z')
    reasons=r['reasons']
    evidence=[]
    for j, reason in enumerate(reasons[:4], start=1):
        evidence.append({"evidence_id":f"EVD-{idx:02d}-{j:02d}","evidence_type":"Graph signal","description":reason,"timestamp":(base+timedelta(hours=idx,minutes=j)).isoformat().replace('+00:00','Z')})
    timeline=[{"event_id":"EVT-0001","type":"CASE_CREATED","title":"Case created","description":f"Investigation opened for {account}.","timestamp":now}]
    if status in {"INVESTIGATING","CLOSED"}:
        timeline.append({"event_id":"EVT-0002","type":"STATUS_CHANGE","title":"Status changed","description":f"Case moved to {status} for analyst review.","timestamp":(base+timedelta(hours=idx,minutes=30)).isoformat().replace('+00:00','Z')})
    if evidence:
        timeline.append({"event_id":"EVT-0003","type":"EVIDENCE","title":"Evidence reviewed","description":f"{len(evidence)} graph-derived evidence items attached.","timestamp":(base+timedelta(hours=idx,minutes=45)).isoformat().replace('+00:00','Z')})
    case_list.append({"case_id":f"CASE-{idx:04d}","account_id":account,"priority":priority,"status":status,"risk_score":r['risk_score'],"risk_status":r['status'],"reasons":reasons,"note":f"Seeded analyst case for {account}. Primary signal: {reasons[0]}","evidence":evidence,"timeline":timeline,"created_at":now,"updated_at":timeline[-1]["timestamp"]})

(ROOT/"data"/"cases.json").write_text(json.dumps(case_list,indent=2),encoding='utf-8')
print('seeded',len(case_list),'cases')
from collections import Counter
print(Counter(c['status'] for c in case_list))
print('scores',[c['risk_score'] for c in case_list])
