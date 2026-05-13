"""Patch @chat-adapter/discord to skip auto-thread creation on mentions.

The upstream adapter (v4.26.0) creates a Discord thread from any channel message
that mentions the bot (including Discord replies, which ping the bot by default).
That makes sense in a multi-user guild — it keeps #general from being cluttered
by bot dialogues — but for Sunshine (solo-user) it fragments scrollback and
breaks Richard's reply-for-context workflow.

This script disables thread creation unconditionally at the two call sites in
the adapter's dist bundle. Idempotent: safe to re-run after a `pnpm install`.

Run on the server:

    cd ~/nanoclaw && python3 scripts/patch_discord_auto_thread.py

Exits 0 if patched or already-patched; non-zero if either call site is missing
(upstream may have restructured — stop and re-investigate before blindly
updating the patch).
"""
import glob
import sys

# Find the adapter bundle. The pnpm hash dir is versioned, so glob it.
candidates = glob.glob(
    "/home/sunshine/nanoclaw/node_modules/.pnpm/@chat-adapter+discord@*/node_modules/@chat-adapter/discord/dist/index.js"
)
if len(candidates) == 0:
    print("ERROR: no @chat-adapter/discord dist/index.js found", file=sys.stderr)
    sys.exit(1)
if len(candidates) > 1:
    print(
        f"WARNING: multiple adapter versions found — patching all:\n  "
        + "\n  ".join(candidates),
        file=sys.stderr,
    )

SENTINEL = "// SUNSHINE-PATCH: auto-thread disabled"

# Both call sites share the same "(!discordThreadId && isMentioned)" guard but
# differ in what message ID they pass to createDiscordThread — data.id vs
# message.id. Patch each distinctly so the sentinel wraps the correct one.
patches = [
    (
        """    if (!discordThreadId && isMentioned) {
      try {
        const newThread = await this.createDiscordThread(channelId, data.id);
        discordThreadId = newThread.id;
        this.logger.debug("Created Discord thread for forwarded mention", {
          channelId,
          messageId: data.id,
          threadId: newThread.id
        });
      } catch (error) {
        this.logger.error("Failed to create Discord thread for mention", {
          error: String(error),
          messageId: data.id
        });
      }
    }""",
        f"""    // {SENTINEL} (forwarded path) — keep channel flat for Sunshine solo-user
    if (false && !discordThreadId && isMentioned) {{
      try {{
        const newThread = await this.createDiscordThread(channelId, data.id);
        discordThreadId = newThread.id;
      }} catch (error) {{
        this.logger.error("Failed to create Discord thread for mention", {{
          error: String(error),
          messageId: data.id
        }});
      }}
    }}""",
    ),
    (
        """    if (!discordThreadId && isMentioned) {
      try {
        const newThread = await this.createDiscordThread(channelId, message.id);
        discordThreadId = newThread.id;
        this.logger.debug("Created Discord thread for incoming mention", {
          channelId,
          messageId: message.id,
          threadId: newThread.id
        });
      } catch (error) {
        this.logger.error("Failed to create Discord thread for mention", {
          error: String(error),
          messageId: message.id
        });
      }
    }""",
        f"""    // {SENTINEL} (gateway path) — keep channel flat for Sunshine solo-user
    if (false && !discordThreadId && isMentioned) {{
      try {{
        const newThread = await this.createDiscordThread(channelId, message.id);
        discordThreadId = newThread.id;
      }} catch (error) {{
        this.logger.error("Failed to create Discord thread for mention", {{
          error: String(error),
          messageId: message.id
        }});
      }}
    }}""",
    ),
]

exit_code = 0
for path in candidates:
    src = open(path).read()
    if SENTINEL in src:
        print(f"SKIP (already patched): {path}")
        continue

    before = src
    for old, new in patches:
        if old not in src:
            print(
                f"ERROR: expected block not found in {path}. Upstream may have "
                f"changed — inspect manually before re-patching.\n"
                f"Missing block (first 120 chars):\n  {old[:120]!r}",
                file=sys.stderr,
            )
            exit_code = 1
            break
        src = src.replace(old, new, 1)
    else:
        if src == before:
            print(f"ERROR: no changes applied to {path}", file=sys.stderr)
            exit_code = 1
            continue
        open(path, "w").write(src)
        print(f"PATCHED: {path}")

sys.exit(exit_code)
