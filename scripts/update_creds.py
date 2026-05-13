#!/usr/bin/env python3
"""
Read KEY=VALUE lines from stdin, update them in:
  - groups/global/.env-creds (most credentials)
  - .env (orchestrator-side: see ENV_KEYS for the full list)
  - data/env/env (mirror of .env that the container reads)

Run from ~/nanoclaw on the Hetzner box.
GitHub aliases (GITHUB_TOKEN, GH_TOKEN, GITHUB_PERSONAL_ACCESS_TOKEN) are kept in sync —
updating any one of them updates all three.
"""
import os
import shutil
import sys

ENV_KEYS = {
    "DISCORD_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "ASSISTANT_NAME",
    "TZ",
    "ONECLI_URL",
    "IDLE_TIMEOUT",
    "RESPOND_TO_SENDERS",
    "OWNER_DISCORD_USER_ID",
}
GITHUB_ALIASES = {"GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"}

new = {}
for line in sys.stdin:
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    new[k.strip()] = v.strip()

if not new:
    print("ERROR: no KEY=VALUE pairs received on stdin", file=sys.stderr)
    sys.exit(1)

# Expand any GitHub alias to all three
gh = next((new[k] for k in GITHUB_ALIASES if k in new), None)
if gh:
    for k in GITHUB_ALIASES:
        new[k] = gh

env_creds_updates = {k: v for k, v in new.items() if k not in ENV_KEYS}
env_updates = {k: v for k, v in new.items() if k in ENV_KEYS}


def patch(path, updates, mode=None):
    if not updates:
        return 0
    lines = open(path).read().splitlines()
    out = []
    seen = set()
    for ln in lines:
        if "=" in ln and not ln.lstrip().startswith("#"):
            k = ln.split("=", 1)[0].strip()
            if k in updates:
                out.append(f"{k}={updates[k]}")
                seen.add(k)
                continue
        out.append(ln)
    # Append any keys not already present
    for k, v in updates.items():
        if k not in seen:
            out.append(f"{k}={v}")
            seen.add(k)
    open(path, "w").write("\n".join(out) + "\n")
    if mode is not None:
        os.chmod(path, mode)
    return len(seen)


creds_count = patch("groups/global/.env-creds", env_creds_updates, mode=0o600)
env_count = patch(".env", env_updates)
if env_count > 0:
    shutil.copy(".env", "data/env/env")

print(f"updated {creds_count} keys in .env-creds")
print(f"updated {env_count} keys in .env (+ mirrored to data/env/env)")

# Keys matching any of these substrings are always fully masked (`***`) —
# even a prefix/suffix leak is unacceptable for credential material.
SENSITIVE_SUBSTRINGS = ("PASSWORD", "SECRET", "TOKEN", "PRIVATE_KEY", "API_KEY", "REFRESH")

def is_sensitive(key):
    return any(s in key for s in SENSITIVE_SUBSTRINGS)

print("masked previews of changed keys:")
for path in ("groups/global/.env-creds", ".env"):
    for ln in open(path):
        if "=" in ln and not ln.lstrip().startswith("#"):
            k = ln.split("=", 1)[0].strip()
            if k in new:
                v = ln.split("=", 1)[1].strip()
                if is_sensitive(k) or len(v) <= 16:
                    masked = "***"
                else:
                    masked = v[:8] + "..." + v[-4:]
                print(f"  {path:30s} {k}={masked}")
