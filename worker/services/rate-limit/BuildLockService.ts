/**
 * BuildLockService - Concurrency lock ensuring at most ONE active build per user at a time.
 * Backed by DORateLimitStore Durable Object with automatic TTL expiry (default 5 minutes).
 */

import type { LockResult } from './DORateLimitStore';

export class BuildLockService {
	private static getLockKey(userId: string): string {
		return `build-lock:${userId}`;
	}

	/**
	 * Attempt to acquire the active build lock for a user.
	 * Returns { acquired: true } or { acquired: false, remainingSeconds }.
	 */
	static async acquire(
		env: Env,
		userId: string,
		agentId?: string,
		ttlSeconds: number = 300,
	): Promise<LockResult> {
		if (!userId || !env.DORateLimitStore) {
			return { acquired: true };
		}
		try {
			const key = this.getLockKey(userId);
			const stub = env.DORateLimitStore.getByName(key);
			return await stub.acquireLock(key, ttlSeconds, agentId);
		} catch (error) {
			console.error('BuildLockService: Failed to acquire lock:', error);
			// Fail open on unexpected error so beta users are not deadlocked
			return { acquired: true };
		}
	}

	/**
	 * Release the active build lock for a user.
	 */
	static async release(
		env: Env,
		userId: string,
		agentId?: string,
	): Promise<boolean> {
		if (!userId || !env.DORateLimitStore) {
			return true;
		}
		try {
			const key = this.getLockKey(userId);
			const stub = env.DORateLimitStore.getByName(key);
			return await stub.releaseLock(key, agentId);
		} catch (error) {
			console.error('BuildLockService: Failed to release lock:', error);
			return false;
		}
	}

	/**
	 * Check if a user currently has an active build running.
	 */
	static async isLocked(env: Env, userId: string): Promise<boolean> {
		if (!userId || !env.DORateLimitStore) {
			return false;
		}
		try {
			const key = this.getLockKey(userId);
			const stub = env.DORateLimitStore.getByName(key);
			return await stub.isLocked(key);
		} catch (error) {
			console.error('BuildLockService: Failed to check lock:', error);
			return false;
		}
	}
}
