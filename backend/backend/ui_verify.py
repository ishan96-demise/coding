import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("FINSENTINELS_BASE_URL", "http://127.0.0.1:8000")

def get(path):
    req = urllib.request.Request(BASE + path, method="GET")
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.status, r.read().decode("utf-8", "replace")

def main():
    required = [
        "index.html",
        "app.js",
        os.path.join("static", "app.js"),
    ]
    for rel in required:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Missing frontend file: {rel}")
        print(f"[OK] {rel}")

    for endpoint in ["/", "/api/health", "/api/network"]:
        status, body = get(endpoint)
        if status != 200:
            raise RuntimeError(f"{endpoint} returned HTTP {status}")
        print(f"[OK] {endpoint}")

    print("\nUI verification PASSED.")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"UI verification FAILED: {exc}")
        sys.exit(1)
