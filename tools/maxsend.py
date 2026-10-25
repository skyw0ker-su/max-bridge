import json, sys, os, subprocess, tempfile

cfg = json.load(open(os.path.expanduser("~/.dsh/max-bot.json"), encoding="utf-8"))
TOKEN = cfg["token"]; CHAT = str(cfg["chat_id"])
BASE = "https://platform-api2.max.ru"

# Панель под каждым сообщением: сессии и новая сессия. Удаление — крестиком
# рядом с названием в меню сессий.
SESSIONS_BUTTON = {
    "type": "inline_keyboard",
    "payload": {
        "buttons": [[
            {"type": "callback", "text": "🐋 Сессии", "payload": "menu"},
            {"type": "callback", "text": "➕ Новая", "payload": "new"},
        ]],
    },
}


CA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "russian_trusted_root_ca.pem")


def _tls_args():
    """Строгая проверка сертификата, если рядом лежит CA Минцифры."""
    if os.path.isfile(CA_FILE):
        return ["--cacert", CA_FILE]
    return ["-k"]


def api(method, path, body=None):
    cmd = ["curl", *_tls_args(), "-s", "--max-time", "40", "-X", method,
           "-H", f"Authorization: {TOKEN}"]
    tmp = None
    if body is not None:
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(body, f, ensure_ascii=False); f.close()
        tmp = f.name
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@" + tmp]
    cmd.append(BASE + path)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True).stdout
    finally:
        # Раньше файлы копились в %TEMP% на каждый вызов.
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    return json.loads(out) if out.strip().startswith("{") else out


def send_text(text, keyboard=True):
    body = {"text": text}
    if keyboard:
        body["attachments"] = [SESSIONS_BUTTON]
    return api("POST", f"/messages?chat_id={CHAT}", body)


def send_image(path, caption=""):
    up = api("POST", "/uploads?type=image")
    out = subprocess.run(["curl", "-k", "-s", "--max-time", "60", "-X", "POST",
                          "-F", f"data=@{path}", up["url"]], capture_output=True, text=True).stdout
    j = json.loads(out)
    token = next(iter(j["photos"].values()))["token"]
    return api("POST", f"/messages?chat_id={CHAT}",
               {"text": caption,
                "attachments": [{"type": "image", "payload": {"token": token}}, SESSIONS_BUTTON]})


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--image":
        print(send_image(a[1], a[2] if len(a) > 2 else ""))
    elif a and a[0] == "--plain":
        print(send_text(a[1], keyboard=False))
    elif a and a[0] == "--file":
        print(send_text(open(a[1], encoding="utf-8").read()))
    else:
        print(send_text(a[0] if a else sys.stdin.read()))
