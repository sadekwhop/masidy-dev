import { describe, expect, it, vi } from 'vitest';
import { DORateLimitStore } from './DORateLimitStore';
import { BuildLockService } from './BuildLockService';

describe('DORateLimitStore Concurrency Locks', () => {
	function createMockStore(): DORateLimitStore {
		const store = Object.create(DORateLimitStore.prototype);
		store.activeLocks = new Map();
		return store;
	}

	it('acquires lock when free and blocks another caller', async () => {
		const store = createMockStore();

		// First caller acquires lock
		const res1 = await store.acquireLock('build-lock:user-1', 300, 'agent-1');
		expect(res1.acquired).toBe(true);

		// Check locked status
		expect(await store.isLocked('build-lock:user-1')).toBe(true);

		// Second caller (different agent) is blocked
		const res2 = await store.acquireLock('build-lock:user-1', 300, 'agent-2');
		expect(res2.acquired).toBe(false);
		expect(res2.remainingSeconds).toBeGreaterThan(0);

		// Same agent can renew (re-entrant)
		const resRenew = await store.acquireLock('build-lock:user-1', 300, 'agent-1');
		expect(resRenew.acquired).toBe(true);

		// Wrong agent cannot release lock
		const releasedWrong = await store.releaseLock('build-lock:user-1', 'agent-2');
		expect(releasedWrong).toBe(false);
		expect(await store.isLocked('build-lock:user-1')).toBe(true);

		// Proper agent releases lock
		const released = await store.releaseLock('build-lock:user-1', 'agent-1');
		expect(released).toBe(true);
		expect(await store.isLocked('build-lock:user-1')).toBe(false);

		// Now second caller can acquire
		const res3 = await store.acquireLock('build-lock:user-1', 300, 'agent-2');
		expect(res3.acquired).toBe(true);
	});

	it('expired lock allows new acquisition automatically', async () => {
		const store = createMockStore();

		// Acquire with 0-second TTL (immediately expires)
		await store.acquireLock('build-lock:user-fast', -1, 'agent-old');

		// New caller immediately acquires
		const res = await store.acquireLock('build-lock:user-fast', 300, 'agent-new');
		expect(res.acquired).toBe(true);
	});
});

type BuildLockEnv = Parameters<typeof BuildLockService.acquire>[0];

describe('BuildLockService', () => {
	it('delegates to env.DORateLimitStore with proper lock key', async () => {
		const mockStub = {
			acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
			releaseLock: vi.fn().mockResolvedValue(true),
			isLocked: vi.fn().mockResolvedValue(false),
		};

		const env = {
			DORateLimitStore: {
				getByName: vi.fn(() => mockStub),
			},
		} as unknown as BuildLockEnv;

		// Acquire
		const acqRes = await BuildLockService.acquire(env, 'user-abc', 'agent-xyz', 300);
		expect(acqRes.acquired).toBe(true);
		expect(env.DORateLimitStore.getByName).toHaveBeenCalledWith('build-lock:user-abc');
		expect(mockStub.acquireLock).toHaveBeenCalledWith('build-lock:user-abc', 300, 'agent-xyz');

		// isLocked
		const locked = await BuildLockService.isLocked(env, 'user-abc');
		expect(locked).toBe(false);
		expect(mockStub.isLocked).toHaveBeenCalledWith('build-lock:user-abc');

		// Release
		const rel = await BuildLockService.release(env, 'user-abc', 'agent-xyz');
		expect(rel).toBe(true);
		expect(mockStub.releaseLock).toHaveBeenCalledWith('build-lock:user-abc', 'agent-xyz');
	});
});
