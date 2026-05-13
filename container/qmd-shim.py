#!/usr/bin/env python3
"""
qmd — container shim. Translates `qmd <cmd> <args>` into a POST to the
host-side qmd-server (running on the box, bound to 127.0.0.1).

Container reaches the host via `host.docker.internal` (Linux Docker maps
this via --add-host=host.docker.internal:host-gateway, set in
src/container-runtime.ts).

Why a shim rather than installing qmd CLI + 300MB embedding model in
the container: see groups/global/tools/qmd-server.mjs for full reasoning.

Supported subcommands: search, vsearch, query, get, multi-get, status.
"""

import json
import os
import sys
import urllib.error
import urllib.request

QMD_SERVER = os.environ.get("QMD_SERVER", "http://host.docker.internal:8183")
TIMEOUT_SEC = 35


def usage():
    sys.stderr.write(
        "usage: qmd <search|vsearch|query|get|multi-get|status> [args...]\n"
        "  search/vsearch/query <text> [-c collection]... [-l limit]\n"
        "  get <path> [-l lines]\n"
        "  multi-get <pattern>\n"
        "  status\n"
    )
    sys.exit(2)


def parse_search_flags(args):
    body = {"query": args[0]}
    i = 1
    collections = []
    while i < len(args):
        if args[i] == "-c" and i + 1 < len(args):
            collections.append(args[i + 1])
            i += 2
        elif args[i] == "-l" and i + 1 < len(args):
            body["limit"] = int(args[i + 1])
            i += 2
        else:
            sys.stderr.write(f"unknown flag: {args[i]}\n")
            sys.exit(2)
    if collections:
        body["collections"] = collections
    return body


def main():
    if len(sys.argv) < 2:
        usage()
    cmd = sys.argv[1]
    rest = sys.argv[2:]

    if cmd in ("search", "vsearch", "query"):
        if not rest:
            usage()
        body = parse_search_flags(rest)
        endpoint = f"/{cmd}"
    elif cmd == "get":
        if not rest:
            usage()
        body = {"path": rest[0]}
        if len(rest) >= 3 and rest[1] == "-l":
            body["lines"] = int(rest[2])
        endpoint = "/get"
    elif cmd == "multi-get":
        if not rest:
            usage()
        body = {"pattern": rest[0]}
        endpoint = "/multi-get"
    elif cmd == "status":
        body = {}
        endpoint = "/status"
    else:
        sys.stderr.write(f"unknown subcommand: {cmd}\n")
        usage()

    req = urllib.request.Request(
        QMD_SERVER + endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # The agent container has HTTP_PROXY pointed at the OneCLI credential
    # gateway for outbound LLM traffic. We MUST bypass it for the host-local
    # qmd-server — otherwise our request gets hijacked and returns empty.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=TIMEOUT_SEC) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        sys.stderr.write(f"qmd-server unreachable at {QMD_SERVER}: {e}\n")
        sys.exit(3)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"qmd-server returned non-JSON: {e}\n")
        sys.exit(3)

    if "error" in data:
        sys.stderr.write(f"qmd-server error: {data['error']}\n")
        sys.exit(2)
    if data.get("stdout"):
        sys.stdout.write(data["stdout"])
    if data.get("stderr"):
        sys.stderr.write(data["stderr"])
    sys.exit(data.get("exitCode", 1))


if __name__ == "__main__":
    main()
