---
name: status
description: One-shot operational status snapshot — service health, running containers, recent log errors, pending approvals, last N inbound messages. Use when the user asks "what's running", "is everything OK", "show me status", or for a quick post-deploy / post-restart sanity check. Read-only.
---

# /status — Sunshine operational snapshot

Run these checks in order and surface anything off:

## 1. Service health
```bash
systemctl --user status nanoclaw | head -8
```
Look for: `Active: active (running)`, no recent restarts.

## 2. Running containers
```bash
docker ps --filter name=nanoclaw- --format "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}"
```
Look for: agent containers (one per active group), uptime makes sense.

## 3. Recent log errors (last 30 min)
```bash
journalctl --user -u nanoclaw --since "30 min ago" -p err
tail -50 ~/nanoclaw/logs/nanoclaw.log | grep -iE "error|fatal|panic" | head -10
```
Look for: anything beyond benign warnings.

## 4. Pending approvals (Discord button-tap waiting)
```bash
ls -la /tmp/nanoclaw-approvals/*.json 2>/dev/null | head
```
Each file = one pending tool call awaiting tap.

## 5. Last 5 inbound messages across groups
```bash
for db in ~/nanoclaw/data/v2-sessions/*/sess-*/inbound.db; do
  sqlite3 "$db" "SELECT timestamp, status, substr(content, 1, 80) FROM messages_in WHERE kind != 'task' ORDER BY seq DESC LIMIT 5" 2>/dev/null
done | head -20
```

## 6. Active scheduled tasks
```bash
for db in ~/nanoclaw/data/v2-sessions/*/sess-*/inbound.db; do
  sqlite3 "$db" "SELECT COUNT(*) FROM messages_in WHERE kind='task' AND status='pending'" 2>/dev/null
done | awk '{s+=$1} END {print s, "pending tasks"}'
```

## 7. Disk + memory
```bash
df -h /home | tail -1
free -h | grep Mem
```

## Report

Compact summary. Flag anything red. If everything green: one line saying so.
