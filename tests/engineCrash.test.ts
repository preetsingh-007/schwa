import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constrainedDevice, crashRecovery, takeEngineCrash, type EngineCrash } from '../src/services/engine';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

const crash = (over: Partial<EngineCrash> = {}): EngineCrash => ({ at: Date.now(), step: 'init', device: 'auto', phonemeModel: 'full', constrained: false, ...over });

describe('engine crash recovery', () => {
  it('reads a recent breadcrumb once, and ignores stale ones', () => {
    store.set('schwa:engine-busy', JSON.stringify(crash()));
    expect(takeEngineCrash()?.step).toBe('init');
    expect(takeEngineCrash()).toBeNull();
    store.set('schwa:engine-busy', JSON.stringify(crash({ at: Date.now() - 60 * 60_000 })));
    expect(takeEngineCrash()).toBeNull();
    expect(store.size).toBe(0);
  });
  it('steps down WebGPU → WASM → low-memory mode', () => {
    expect(crashRecovery(crash()).settings).toEqual({ device: 'wasm' });
    expect(crashRecovery(crash({ device: 'webgpu', constrained: true })).settings).toEqual({ device: 'wasm' });
    // on a phone "auto" already meant WASM, so the next step is low-memory mode
    expect(crashRecovery(crash({ constrained: true })).settings).toEqual({ phonemeModel: 'off' });
    expect(crashRecovery(crash({ device: 'wasm' })).settings).toEqual({ phonemeModel: 'off' });
    expect(crashRecovery(crash({ device: 'wasm', phonemeModel: 'off' })).settings).toEqual({});
    expect(crashRecovery(crash()).message).toMatch(/progress is safe/);
  });
  it('treats iPhones, iPads and small-memory devices as constrained', () => {
    const as = (userAgent: string, maxTouchPoints = 0, deviceMemory?: number) => { vi.stubGlobal('navigator', { userAgent, maxTouchPoints, deviceMemory }); return constrainedDevice(); };
    expect(as('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15')).toBe(true);
    expect(as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5)).toBe(true); // iPad in desktop mode
    expect(as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)).toBe(false);
    expect(as('Mozilla/5.0 (Linux; Android 14) Chrome/130', 5, 4)).toBe(true);
    expect(as('Mozilla/5.0 (Windows NT 10.0) Chrome/130', 0, 8)).toBe(false);
  });
});
