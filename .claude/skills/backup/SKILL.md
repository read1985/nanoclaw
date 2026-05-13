---
name: backup
description: Archive everything that would be lost in a box rebuild — memory + sessions DB + scheduled tasks + group configs. Output is a single tar.gz uploaded to Dropbox via dropbox.py. Use when the user says "back up the box", before major upgrades, or as a one-shot belt-and-braces before risky operations. Does NOT replace the daily-backup cron (that's git-based and only covers groups/global).
---

# /backup — Belt-and-braces full snapshot of Sunshine

Daily backup cron at 22:00 AEST handles `groups/global/` (memory, persona files) via git push to `read1985/jarvis-workspace-nanoclaw`. This skill covers what daily backup *doesn't*: session DBs, scheduled tasks, host configs.

## What to archive

| Path | Why |
|---|---|
| `~/nanoclaw/data/v2.db` | Central DB: agent_groups, users, channels, permissions |
| `~/nanoclaw/data/v2-sessions/` | Per-session inbound/outbound DBs + scheduled tasks (kind='task' rows) |
| `~/nanoclaw/.env` | Host config (not creds — those are in `.env-creds` which we treat separately) |
| `~/nanoclaw/.claude/skills/` | Custom + upstream skill files |
| `~/.config/systemd/user/nanoclaw.service` | systemd unit |
| `~/.config/nanoclaw/` | Mount allowlist, sender allowlist |

## What NOT to archive (handled elsewhere)

- `groups/global/` — daily git backup to jarvis-workspace-nanoclaw
- `.env-creds` — sensitive; rotate via Bitwarden + `update_creds.py`, don't snapshot
- `node_modules/` — reinstall from `pnpm-lock.yaml`
- Docker images — rebuild from Dockerfile

## Procedure

1. Stop the agent runner briefly (to quiesce DB writes):
   ```bash
   systemctl --user stop nanoclaw
   ```
2. Create tar.gz with timestamp:
   ```bash
   TS=$(date -u +%Y%m%dT%H%M%SZ)
   tar czf "/tmp/sunshine-backup-$TS.tar.gz" \
     -C ~/nanoclaw data/v2.db data/v2-sessions .env .claude/skills \
     -C ~ .config/systemd/user/nanoclaw.service .config/nanoclaw
   ls -lh "/tmp/sunshine-backup-$TS.tar.gz"
   ```
3. Restart:
   ```bash
   systemctl --user start nanoclaw
   ```
4. Upload to Dropbox using the dropbox tool:
   ```bash
   /workspace/global/tools/p3 /workspace/global/tools/dropbox.py upload "/tmp/sunshine-backup-$TS.tar.gz" /backups/sunshine/
   ```
5. Delete local copy after upload confirms:
   ```bash
   rm "/tmp/sunshine-backup-$TS.tar.gz"
   ```
6. Report: size, Dropbox path, restart confirmation.

## Restore note

To restore: stop nanoclaw, extract tar.gz back to ~/nanoclaw, restart. The `groups/global/` directory needs separate restore from its own git repo (`git clone read1985/jarvis-workspace-nanoclaw groups/global`).
