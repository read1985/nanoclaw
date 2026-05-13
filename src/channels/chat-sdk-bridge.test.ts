import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import {
  createChatSdkBridge,
  deliverWithDiscord429Retry,
  parse429RetryAfter,
  resolveTid,
  splitForLimit,
  stripAgentSuffix,
} from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('resolveTid', () => {
  it('returns threadId when non-empty', () => {
    expect(resolveTid('thread-abc', 'platform-xyz')).toBe('thread-abc');
  });

  it('falls back to platformId when threadId is null', () => {
    expect(resolveTid(null, 'platform-xyz')).toBe('platform-xyz');
  });

  it('falls back to platformId when threadId is undefined', () => {
    expect(resolveTid(undefined, 'platform-xyz')).toBe('platform-xyz');
  });

  it('falls back to platformId when threadId is empty string', () => {
    // The bug behind `Invalid Discord thread ID: ""` — `??` alone would let
    // the empty string through.
    expect(resolveTid('', 'platform-xyz')).toBe('platform-xyz');
  });
});

describe('stripAgentSuffix', () => {
  it('strips :ag_<id> suffix from internal messageIds', () => {
    expect(stripAgentSuffix('1496835765265760306:ag_b26be4d02e91')).toBe('1496835765265760306');
  });

  it('returns the input unchanged when no agent suffix is present', () => {
    expect(stripAgentSuffix('1496835765265760306')).toBe('1496835765265760306');
  });

  it('only strips the agent suffix, not other colons', () => {
    expect(stripAgentSuffix('discord:guild:channel')).toBe('discord:guild:channel');
  });
});

describe('parse429RetryAfter', () => {
  it('returns null for non-429 errors', () => {
    expect(parse429RetryAfter(new Error('NetworkError: ECONNRESET'))).toBeNull();
  });

  it('extracts retry_after from Discord 429 body', () => {
    const err = new Error(
      'Discord API error: 429 {"message": "You are being rate limited.", "retry_after": 0.523, "global": false}',
    );
    expect(parse429RetryAfter(err)).toBeCloseTo(0.523);
  });

  it('returns 1s default when 429 has no parseable retry_after', () => {
    expect(parse429RetryAfter(new Error('Discord API error: 429 (no body)'))).toBe(1);
  });
});

describe('deliverWithDiscord429Retry', () => {
  it('returns the result on first success without sleeping', async () => {
    let calls = 0;
    const result = await deliverWithDiscord429Retry(async () => {
      calls++;
      return 'ok';
    }, 'test');
    expect(calls).toBe(1);
    expect(result).toBe('ok');
  });

  it('retries on a 429, then succeeds', async () => {
    let calls = 0;
    const result = await deliverWithDiscord429Retry(async () => {
      calls++;
      if (calls === 1) {
        throw new Error('Discord API error: 429 {"retry_after": 0.01}');
      }
      return 'ok';
    }, 'test');
    expect(calls).toBe(2);
    expect(result).toBe('ok');
  });

  it('rethrows the original error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      deliverWithDiscord429Retry(
        async () => {
          calls++;
          throw new Error('Discord API error: 429 {"retry_after": 0.01}');
        },
        'test',
        2,
      ),
    ).rejects.toThrow(/429/);
    expect(calls).toBe(2);
  });

  it('rethrows non-429 errors immediately without retry', async () => {
    let calls = 0;
    await expect(
      deliverWithDiscord429Retry(async () => {
        calls++;
        throw new Error('NetworkError: ECONNRESET');
      }, 'test'),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(1);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});
