import json, os, subprocess, tempfile

CFG = os.path.expanduser("~/.dsh/max-bot.json")
MARK = os.path.expanduser("~/.dsh/max-marker.txt")
cfg = json.load(open(CFG, encoding="utf-8"))
TOKEN = cfg["token"]; CHAT = str(cfg["chat_id"])
BASE = "https://platform-api2.max.ru"

def api(method, path, body=None):
    cmd = ["curl", "-k", "-s", "--max-time", "60", "-X", method, "-H", f"Authorization: {TOKEN}"]
    if body is not None:
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(body, f, ensure_ascii=False); f.close()
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@" + f.name]
    cmd.append(BASE + path)
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out}

def read_new(timeout=2):
    marker = open(MARK).read().strip() if os.path.exists(MARK) else ""
    path = f"/updates?timeout={timeout}&limit=50"
    if marker:
        path += f"&marker={marker}"
    r = api("GET", path)
    if r.get("marker"):
        open(MARK, "w").write(str(r["marker"]))
    out = []
    for u in r.get("updates", []):
        m = u.get("message")
        if m and m.get("body", {}).get("text"):
            out.append({"from": m["sender"].get("name"), "text": m["body"]["text"],
                        "ts": m.get("timestamp")})
    return out

def send(text):
    return api("POST", f"/messages?chat_id={CHAT}", {"text": text})

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--send":
        print(send(" ".join(sys.argv[2:])))
    else:
        msgs = read_new()
        if not msgs:
            print("новых сообщений нет")
        else:
            for m in msgs:
                print(f"[{m['from']}] {m['text']}")