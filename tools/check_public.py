"""Pre-deploy check: nothing private may be inside docs/ (the GitHub Pages root) or staged in git.

    python tools/check_public.py

Fails (exit 1) when docs/ or the git index contains credential-like files or token-like strings.
"""
import re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
BAD_NAMES = re.compile(r"(token|secret|credential|wallet|\.env|\.pem|\.key$|id_rsa)", re.I)
TOKEN_RE = re.compile(rb"(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|gho_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})")
TEXT_EXT = {".html", ".js", ".mjs", ".json", ".md", ".css", ".txt", ".py", ".svg", ".yml", ".yaml"}
problems = []

for p in DOCS.rglob("*"):
    if not p.is_file(): continue
    rel = p.relative_to(ROOT).as_posix()
    if BAD_NAMES.search(p.name): problems.append(f"suspicious file name in public folder: {rel}")
    if p.suffix.lower() in TEXT_EXT and TOKEN_RE.search(p.read_bytes()): problems.append(f"token-like string in: {rel}")

staged = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True).stdout.split()
for f in staged:
    if BAD_NAMES.search(Path(f).name) and not f.startswith("tools/") and not f.startswith("tests/"):
        problems.append(f"credential-like file is tracked or unignored: {f}")
    fp = ROOT / f
    if fp.suffix.lower() in TEXT_EXT and fp.is_file() and TOKEN_RE.search(fp.read_bytes()): problems.append(f"token-like string in tracked file: {f}")

for must_ignore in ("Githubtoken.txt", "data/wallet.json", ".env"):
    r = subprocess.run(["git", "check-ignore", "-q", must_ignore], cwd=ROOT)
    if r.returncode != 0: problems.append(f"not ignored by .gitignore: {must_ignore}")

if problems:
    print("\n".join("FAIL " + p for p in problems)); sys.exit(1)
print(f"OK  docs/ ({sum(1 for p in DOCS.rglob('*') if p.is_file())} files) and git index contain no credential files or token-like strings")
