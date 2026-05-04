import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';

// Per F-10 and the Phase 2 implementation opinion: the avatar resolver
// is a filesystem module, so mocking fs would test the mock and not the
// resolver. Spin up a real temp directory and redirect STORE_DIR /
// PROJECT_ROOT / resolveAgentDir at it via module mocks. Each test is
// responsible for staging the files it needs and clearing them in
// afterEach so cases stay independent.

const { TEST_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  return {
    TEST_ROOT: fs.mkdtempSync(
      path.join(os.tmpdir(), 'claudeclaw-avatars-test-'),
    ),
  };
});

vi.mock('./config.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  return {
    PROJECT_ROOT: TEST_ROOT,
    STORE_DIR: path.join(TEST_ROOT, 'store'),
    CLAUDECLAW_CONFIG: path.join(TEST_ROOT, 'config'),
    expandHome: (p: string) => p,
  };
});

vi.mock('./agent-config.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  return {
    resolveAgentDir: (id: string) => path.join(TEST_ROOT, 'agents', id),
    loadAgentConfig: (id: string) => {
      const cfgFile = path.join(TEST_ROOT, 'agents', id, '.fake-config.json');
      if (!fs.existsSync(cfgFile)) {
        throw new Error(`no config for ${id}`);
      }
      return JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    },
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  resolveAgentAvatar,
  getMutableAvatarPath,
  writeUploadedAvatar,
  deleteUploadedAvatar,
  avatarEtag,
  tryFetchTelegramAvatar,
} = await import('./avatars.js');

const STORE_DIR = path.join(TEST_ROOT, 'store');
const BUNDLED_DIR = path.join(TEST_ROOT, 'warroom', 'avatars');
const AGENTS_DIR = path.join(TEST_ROOT, 'agents');

// Twelve-byte canonical magic-byte payloads for the three accepted
// formats, plus a non-image control payload. Twelve bytes is what the
// resolver inspects (RIFF/WEBP needs offsets 8..11).
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01,
]);
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);
const HTML_BYTES = Buffer.from('<!doctype html><html></html>', 'utf8');

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeFakeAgentConfig(agentId: string, opts: { botToken: string }): void {
  const dir = path.join(AGENTS_DIR, agentId);
  ensureDir(dir);
  fs.writeFileSync(
    path.join(dir, '.fake-config.json'),
    JSON.stringify(opts),
  );
}

function nukeTestDirs(): void {
  for (const d of [STORE_DIR, BUNDLED_DIR, AGENTS_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

beforeEach(() => {
  nukeTestDirs();
  ensureDir(STORE_DIR);
  ensureDir(BUNDLED_DIR);
  ensureDir(AGENTS_DIR);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

// ── 1. resolveAgentAvatar priority order ──────────────────────────────
describe('resolveAgentAvatar', () => {
  it('priority: mutable > bundled-meet (when ctx=meet) > bundled > null', () => {
    const id = 'comms';
    ensureDir(path.join(AGENTS_DIR, id));

    expect(resolveAgentAvatar(id)).toBeNull();

    fs.writeFileSync(path.join(BUNDLED_DIR, `${id}.png`), PNG_BYTES);
    let r = resolveAgentAvatar(id);
    expect(r?.source).toBe('bundled');
    expect(r?.absPath).toBe(path.join(BUNDLED_DIR, `${id}.png`));

    fs.writeFileSync(path.join(BUNDLED_DIR, `${id}-meet.png`), PNG_BYTES);
    r = resolveAgentAvatar(id, { context: 'meet' });
    expect(r?.source).toBe('bundled-meet');
    r = resolveAgentAvatar(id, { context: 'default' });
    expect(r?.source).toBe('bundled');

    fs.writeFileSync(path.join(AGENTS_DIR, id, 'avatar.png'), PNG_BYTES);
    r = resolveAgentAvatar(id, { context: 'meet' });
    expect(r?.source).toBe('user');
    r = resolveAgentAvatar(id);
    expect(r?.source).toBe('user');
  });

  it('returns null for invalid id', () => {
    expect(resolveAgentAvatar('bad id with spaces')).toBeNull();
    expect(resolveAgentAvatar('../../etc/passwd')).toBeNull();
    expect(resolveAgentAvatar('')).toBeNull();
  });
});

// ── 2. getMutableAvatarPath ──────────────────────────────────────────
describe('getMutableAvatarPath', () => {
  it('main resolves to STORE_DIR/avatars/main.png', () => {
    expect(getMutableAvatarPath('main')).toBe(
      path.join(STORE_DIR, 'avatars', 'main.png'),
    );
  });

  it('sub-agent resolves to resolveAgentDir(id)/avatar.png', () => {
    expect(getMutableAvatarPath('comms')).toBe(
      path.join(AGENTS_DIR, 'comms', 'avatar.png'),
    );
  });
});

// ── 3. writeUploadedAvatar ───────────────────────────────────────────
describe('writeUploadedAvatar', () => {
  it('accepts PNG, JPEG, and WebP', async () => {
    ensureDir(path.join(AGENTS_DIR, 'comms'));
    const png = await writeUploadedAvatar('comms', PNG_BYTES);
    expect(png.bytes).toBe(PNG_BYTES.length);
    expect(fs.existsSync(png.absPath)).toBe(true);

    const jpeg = await writeUploadedAvatar('content', JPEG_BYTES);
    expect(jpeg.bytes).toBe(JPEG_BYTES.length);

    const webp = await writeUploadedAvatar('research', WEBP_BYTES);
    expect(webp.bytes).toBe(WEBP_BYTES.length);
  });

  it('rejects non-image bytes via magic-byte sniff', async () => {
    await expect(writeUploadedAvatar('comms', HTML_BYTES))
      .rejects.toThrow(/PNG, JPEG, or WebP/);
  });

  it('clears the .no-avatar flag on a successful write', async () => {
    const id = 'comms';
    const dir = path.join(AGENTS_DIR, id);
    ensureDir(dir);
    const flag = path.join(dir, '.no-avatar');
    fs.writeFileSync(flag, '');
    expect(fs.existsSync(flag)).toBe(true);

    await writeUploadedAvatar(id, PNG_BYTES);
    expect(fs.existsSync(flag)).toBe(false);
  });
});

// ── 4. deleteUploadedAvatar ──────────────────────────────────────────
describe('deleteUploadedAvatar', () => {
  it('is idempotent: no throw when the file is missing', async () => {
    const id = 'comms';
    ensureDir(path.join(AGENTS_DIR, id));
    await expect(deleteUploadedAvatar(id)).resolves.toBeUndefined();
    await expect(deleteUploadedAvatar(id)).resolves.toBeUndefined();
  });
});

// ── 5. avatarEtag ────────────────────────────────────────────────────
describe('avatarEtag', () => {
  it('is stable for an unchanged file', async () => {
    ensureDir(path.join(AGENTS_DIR, 'comms'));
    await writeUploadedAvatar('comms', PNG_BYTES);
    const r1 = resolveAgentAvatar('comms');
    const r2 = resolveAgentAvatar('comms');
    expect(r1).not.toBeNull();
    expect(avatarEtag(r1!)).toBe(avatarEtag(r2!));
  });

  it('changes after a rewrite', async () => {
    ensureDir(path.join(AGENTS_DIR, 'comms'));
    await writeUploadedAvatar('comms', PNG_BYTES);
    const before = avatarEtag(resolveAgentAvatar('comms')!);

    // Force mtime advance + size change so the etag must shift.
    await new Promise((r) => setTimeout(r, 15));
    const longerPng = Buffer.concat([PNG_BYTES, Buffer.alloc(64, 0xab)]);
    await writeUploadedAvatar('comms', longerPng);

    const after = avatarEtag(resolveAgentAvatar('comms')!);
    expect(after).not.toBe(before);
  });
});

// ── 6. Per-agent mutex ───────────────────────────────────────────────
describe('per-agent write mutex', () => {
  it('serializes concurrent writes (active count never exceeds 1)', async () => {
    ensureDir(path.join(AGENTS_DIR, 'comms'));

    let active = 0;
    let peak = 0;

    // Wrap fs.writeFileSync via a spy that bumps a shared counter for
    // the brief window the write is "active". If the mutex is doing its
    // job, peak stays at 1.
    const real = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      target: any,
      data: any,
      opts?: any,
    ) => {
      active += 1;
      if (active > peak) peak = active;
      // Simulate a slow IO so contention shows up if it would.
      const start = Date.now();
      while (Date.now() - start < 8) { /* spin */ }
      const out = real(target, data, opts);
      active -= 1;
      return out;
    }) as typeof fs.writeFileSync);

    try {
      await Promise.all([
        writeUploadedAvatar('comms', PNG_BYTES),
        writeUploadedAvatar('comms', JPEG_BYTES),
        writeUploadedAvatar('comms', WEBP_BYTES),
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(peak).toBeLessThanOrEqual(1);
  });
});

// ── 7. tryFetchTelegramAvatar ────────────────────────────────────────
describe('tryFetchTelegramAvatar', () => {
  it('returns false and sets the .no-avatar flag when bot has no photo', async () => {
    const id = 'comms';
    writeFakeAgentConfig(id, { botToken: 'fake-token' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { id: 1, username: 'x' } }),
    }));

    const ok = await tryFetchTelegramAvatar(id);
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(AGENTS_DIR, id, '.no-avatar'))).toBe(true);
  });

  it('returns false on a Telegram 401 response without crashing', async () => {
    const id = 'content';
    writeFakeAgentConfig(id, { botToken: 'bad-token' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
    }));

    await expect(tryFetchTelegramAvatar(id)).resolves.toBe(false);
  });

  it('caches a successful download to the mutable path', async () => {
    const id = 'research';
    writeFakeAgentConfig(id, { botToken: 'good-token' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { id: 2, username: 'r', photo: { small_file_id: 'AAA' } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => PNG_BYTES.buffer.slice(
          PNG_BYTES.byteOffset,
          PNG_BYTES.byteOffset + PNG_BYTES.byteLength,
        ),
      });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await tryFetchTelegramAvatar(id);
    expect(ok).toBe(true);
    const cached = path.join(AGENTS_DIR, id, 'avatar.png');
    expect(fs.existsSync(cached)).toBe(true);
    expect(fs.readFileSync(cached).equals(PNG_BYTES)).toBe(true);
    // Three Telegram round-trips: getMe, getFile, file download.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
