import json, sys, os, subprocess, tempfile

cfg = json.load(open(os.path.expanduser("~/.dsh/max-bot.json"), encoding="utf-8"))
TOKEN = cfg["token"]; CHAT = str(cfg["chat_id"])
BASE = "https://platform-api2.max.ru"

# Кнопка «Сессии» под каждым сообщением — открывает меню выбора сессии DeepSeek.
SESSIONS_BUTTON = {
    "type": "inline_keyboard",
    "payload": {"buttons": [[{"type": "callback", "text": "🐋 Сессии", "payload": "menu"}]]},
}


def api(method, path, body=None):
    cmd = ["curl", "-k", "-s", "--max-time", "40", "-X", method,
           "-H", f"Authorization: {TOKEN}"]
    if body is not None:
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(body, f, ensure_ascii=False); f.close()
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@" + f.name]
    cmd.append(BASE + path)
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
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
