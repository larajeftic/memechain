"""Push to origin using a token file without ever putting the token in a URL, the shell or the log.

    python tools/git_push.py            # verifies the token's account can push to the remote, then pushes
    python tools/git_push.py --check    # only report account / permissions

Token files, first one that exists wins: MainGithub.txt, then Githubtoken.txt (both gitignored).
The token is handed to git through a one-shot credential helper on stdin. It is never printed.
"""
import os, subprocess, sys, requests
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILES = [ROOT / "MainGithub.txt", ROOT / "Githubtoken.txt"]

if len(sys.argv) > 1 and sys.argv[1] == "--helper":          # invoked by git: print credentials for the remote
    if sys.argv[3] == "get":
        print("username=x-access-token"); print("password=" + Path(sys.argv[2]).read_text(encoding="utf-8").strip())
    sys.exit(0)

TOKEN_FILE = next((f for f in TOKEN_FILES if f.exists() and f.read_text(encoding="utf-8").strip()), None)
tok = TOKEN_FILE.read_text(encoding="utf-8").strip() if TOKEN_FILE else ""
if not tok:
    print("no token file (MainGithub.txt or Githubtoken.txt)"); sys.exit(1)
H = {"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json"}
remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
slug = remote.replace("https://github.com/", "").removesuffix(".git")
me = requests.get("https://api.github.com/user", headers=H, timeout=20)
login = me.json().get("login") if me.ok else None
repo = requests.get(f"https://api.github.com/repos/{slug}", headers=H, timeout=20)
perms = repo.json().get("permissions", {}) if repo.ok else {}
print(f"remote: {remote}\ntoken file: {TOKEN_FILE.name}\ntoken account: {login or 'invalid token'}\npush permission on {slug}: {perms.get('push', False)}")
if "--check" in sys.argv: sys.exit(0)
if not perms.get("push"):
    print("BLOCKED: this token cannot push to the existing remote. Not pushing anywhere else."); sys.exit(2)

helper = f"!python \"{Path(__file__).as_posix()}\" --helper \"{TOKEN_FILE.as_posix()}\""
r = subprocess.run(["git", "-c", "credential.helper=", "-c", f"credential.helper={helper}", "push", "-u", "origin", "main"],
                   cwd=ROOT, capture_output=True, text=True)
print((r.stdout + r.stderr).replace(tok, "<token>").strip()[-800:]); sys.exit(r.returncode)
