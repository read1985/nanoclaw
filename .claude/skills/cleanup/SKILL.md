---
name: cleanup
description: Reclaim disk on the Sunshine box. Prunes old container images, stops orphan containers, removes completed sessions older than N days, vacuums SQLite DBs, clears stale .bak files. Use when the user says "free up disk", "clean up the box", or after a long-running session with many completed tasks. Destructive — show what will be removed before doing it.
---

# /cleanup — Reclaim disk on Sunshine

Multi-pass. Each pass: show the proposed deletions, get user OK, then execute.

## Pre-flight: current disk
```bash
df -h /home
docker system df
```

## Pass 1 — Stale container images
```bash
# Tagged images older than 14d AND not equal to nanoclaw-agent:v2 (the live tag)
docker images nanoclaw-agent --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}'
docker images --filter "dangling=true"
```
Remove after confirmation: `docker image rm <tag>` (per-tag, not `prune -a` — that's too aggressive).

## Pass 2 — Orphan stopped containers
```bash
docker ps -a --filter "status=exited" --filter "name=nanoclaw-" --format "{{.Names}}\t{{.Status}}"
```
Remove: `docker rm <name>` after confirmation.

## Pass 3 — Old completed session directories
```bash
find ~/nanoclaw/data/v2-sessions -name "sess-*" -type d -mtime +30 -printf "%T+ %p\n" | sort | head -20
```
Each session dir has inbound.db + outbound.db. Verify no live processes use them, then rm -rf the ones >30d old.

## Pass 4 — Vacuum live session DBs
```bash
for db in ~/nanoclaw/data/v2-sessions/*/sess-*/inbound.db ~/nanoclaw/data/v2-sessions/*/sess-*/outbound.db; do
  before=$(stat -c%s "$db")
  sqlite3 "$db" "VACUUM"
  after=$(stat -c%s "$db")
  if [ "$before" -ne "$after" ]; then echo "$db: $before → $after bytes"; fi
done
```

## Pass 5 — .bak files in repo
```bash
find ~/nanoclaw -name "*.bak-*" -o -name "*.bak" 2>/dev/null
find ~/nanoclaw/groups/global -name "*.bak-*" 2>/dev/null
```
These accumulate from past patches. After confirmation: rm.

## Pass 6 — Old memory backups
```bash
ls -lt ~/nanoclaw/groups/global/.memory-backups/ | tail -n +20  # keep newest 20
```
Remove anything past index 20.

## Post-flight
```bash
df -h /home
docker system df
```

Report: bytes reclaimed per pass + total.
