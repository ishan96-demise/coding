import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = "http://127.0.0.1:8765"


def request(path, method="GET", payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            body = json.loads(raw)
        except Exception:
            body = {"detail": raw}
        return exc.code, body


def main():
    sys.path.insert(0, ROOT)
    cases_file = os.path.join(ROOT, "data", "cases.json")
    settings_file = os.path.join(ROOT, "data", "settings.json")
    with open(cases_file, "rb") as f:
        cases_backup = f.read()
    with open(settings_file, "rb") as f:
        settings_backup = f.read()
    import main as app_module
    from graph_builder import load_graph_data, load_transactions

    assert os.path.isfile(os.path.join(ROOT, "index.html"))
    assert os.path.isfile(os.path.join(ROOT, "app.js"))
    assert os.path.isfile(os.path.join(ROOT, "graph_builder.py"))

    routes = {route.path for route in app_module.app.routes}
    required = {
        "/api/health",
        "/api/score/{account_id}",
        "/api/graph/{account_id}",
        "/api/network",
        "/api/alerts",
        "/api/analytics",
        "/api/cases",
        "/api/cases/{case_id}",
        "/api/cases/{case_id}/evidence",
        "/api/profile",
        "/api/settings",
        "/static",
    }
    missing = sorted(path for path in required if path not in routes and path != "/static")
    assert not missing, f"Missing routes: {missing}"

    graph = load_graph_data()
    transactions = load_transactions()
    assert transactions, "No transactions loaded"
    assert graph.number_of_nodes() > 0, "Graph is empty"
    print(f"[OK] Python import, files and graph ({len(transactions)} transactions)")

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8765"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                status, health = request("/api/health")
                if status == 200 and health.get("status") == "healthy":
                    break
            except Exception:
                time.sleep(0.3)
        else:
            raise RuntimeError("Uvicorn did not become healthy")

        print("[OK] /api/health")

        status, network = request("/api/network")
        assert status == 200, network
        full_graph = network.get("graph", network)
        accounts = [node["id"] for node in full_graph.get("nodes", []) if node.get("type") == "account"]
        assert accounts, "No accounts in graph"
        account = "ACC_666" if "ACC_666" in accounts else accounts[0]
        print(f"[OK] /api/network ({len(accounts)} accounts)")

        for path in [
            "/api/analytics",
            "/api/alerts",
            "/api/cases",
            "/api/profile",
            "/api/settings",
            f"/api/score/{account}",
            f"/api/graph/{account}",
        ]:
            status, body = request(path)
            assert status == 200, (path, status, body)
            print(f"[OK] {path}")

        status, created = request(
            "/api/cases",
            "POST",
            {
                "account_id": account,
                "priority": "HIGH",
                "note": "Automated verification case",
            },
        )
        assert status in (200, 201), created
        case_id = created["case_id"]
        print(f"[OK] Create case -> {case_id}")

        status, opened = request(f"/api/cases/{case_id}")
        assert status == 200 and opened["case_id"] == case_id
        print("[OK] Open case")

        status, evidence = request(
            f"/api/cases/{case_id}/evidence",
            "POST",
            {
                "evidence_type": "Verification",
                "description": "Automated end-to-end verification evidence",
            },
        )
        assert status == 200, evidence
        print("[OK] Add evidence")

        status, updated = request(
            f"/api/cases/{case_id}",
            "PATCH",
            {"status": "INVESTIGATING"},
        )
        assert status == 200 and updated["status"] == "INVESTIGATING"
        print("[OK] Case -> INVESTIGATING")

        status, updated = request(
            f"/api/cases/{case_id}",
            "PATCH",
            {"status": "CLOSED"},
        )
        assert status == 200 and updated["status"] == "CLOSED"
        print("[OK] Case -> CLOSED")

        print("\nVerification PASSED.")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

        with open(cases_file, "wb") as f:
            f.write(cases_backup)
        with open(settings_file, "wb") as f:
            f.write(settings_backup)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Verification FAILED: {exc}")
        sys.exit(1)
