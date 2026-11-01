import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { SpaceWorkspaceOps } from './space-workspace-ops';

/**
 * Format bytes into human-readable string.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Normalize any workspace path to an absolute slash-prefixed path without
 * trailing slash (unless root), collapsing redundant slashes and dots.
 * E.g. "wrangler.json" -> "/wrangler.json", "src/index.ts" -> "/src/index.ts".
 */
export function normalizeWorkspacePath(path: string): string {
	const trimmed = path.trim().replace(/\\/g, '/');
	const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
	const parts = withLeading.split('/').filter(Boolean);
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '.') continue;
		if (part === '..') {
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}
	return `/${resolved.join('/')}`;
}

/**
 * Get the parent directory of a normalized path.
 * E.g. "/wrangler.json" -> "/", "/src/index.ts" -> "/src", "/public/css/style.css" -> "/public/css".
 */
export function getParentDir(normalizedPath: string): string {
	const lastSlash = normalizedPath.lastIndexOf('/');
	if (lastSlash <= 0) return '/';
	return normalizedPath.slice(0, lastSlash);
}

/**
 * SpaceDO-aware write tool.
 *
 * Replaces `@cloudflare/think`'s default `createWriteTool` to fix a critical
 * bug: Think's `path.replace(/\/[^/]+$/, "")` fails on paths without a leading
 * slash (e.g. `"wrangler.json"` -> `"wrangler.json"`), which causes it to call
 * `ops.mkdir("wrangler.json")` and create root files as directories!
 *
 * This version:
 * 1. Normalizes the path with {@link normalizeWorkspacePath}.
 * 2. Computes the parent directory cleanly and only creates parent dirs when `parent !== '/'`.
 * 3. Self-heals: if an accidental directory already exists at `path`, removes it before writing.
 */
export function createSpaceWriteTool(options: { ops: SpaceWorkspaceOps }): Tool {
	const { ops } = options;
	return tool({
		description:
			'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.',
		inputSchema: z.object({
			path: z.string().describe('Absolute path to the file (e.g. "/wrangler.json" or "/src/index.ts")'),
			content: z.string().describe('Content to write to the file'),
		}),
		execute: async ({ path, content }) => {
			const normalized = normalizeWorkspacePath(path);
			const parent = getParentDir(normalized);
			if (parent && parent !== '/') {
				await ops.mkdir(parent, { recursive: true });
			}

			// Self-healing: if normalized is currently a directory, remove it so the file can be written.
			const existing = await ops.stat(normalized);
			if (existing && existing.type === 'directory') {
				console.warn(`[workspace-tools] Removing pre-existing directory at file path ${normalized}`);
				await ops.rm(normalized, { recursive: true, force: true });
			}

			await ops.writeFile(normalized, content);
			const lines = content.split('\n').length;
			return {
				path: normalized,
				bytesWritten: new TextEncoder().encode(content).byteLength,
				lines,
			};
		},
	});
}

/**
 * SpaceDO-aware list tool.
 *
 * Replaces `@cloudflare/think`'s default `createListTool` to fix a critical
 * hallucination loop: when an agent calls `list({ path: "wrangler.json" })` on
 * a file, `readDir` throws ENOTDIR which was caught and returned `[]`.
 * Think's list tool formatted that as `{ path: "/wrangler.json", count: 0, entries: [] }`,
 * misleading the LLM into believing the file was an empty directory.
 *
 * This version:
 * 1. Normalizes the path.
 * 2. Checks `ops.stat()` first. If `path` is a file, returns a clear error
 *    informing the agent that it is a file and to use `read` instead.
 * 3. If directory does not exist, returns a clear `Directory not found` error.
 * 4. Lists directories properly with entry types and sizes.
 */
export function createSpaceListTool(options: { ops: SpaceWorkspaceOps }): Tool {
	const { ops } = options;
	return tool({
		description: 'List files and directories in a given path. Returns names, types, and sizes for each entry.',
		inputSchema: z.object({
			path: z.string().default('/').describe('Absolute path to the directory to list'),
			limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of entries to return (default: 200)'),
			offset: z.number().int().min(0).optional().describe('Number of entries to skip (for pagination)'),
		}),
		execute: async ({ path, limit, offset }) => {
			const normalized = normalizeWorkspacePath(path);
			const st = await ops.stat(normalized);
			if (st && st.type === 'file') {
				return {
					error: `'${normalized}' is a file (${formatSize(st.size)}), not a directory. Use the read tool to view its content.`,
				};
			}
			if (!st && normalized !== '/') {
				return {
					error: `Directory not found: ${normalized}`,
				};
			}
			const maxEntries = limit ?? 200;
			const entries = await ops.readDir(normalized, {
				limit: maxEntries,
				offset: offset ?? 0,
			});
			const formatted = entries.map((entry) => {
				const suffix = entry.type === 'directory' ? '/' : '';
				const sizeStr = entry.type === 'file' ? ` (${formatSize(entry.size)})` : '';
				return `${entry.name}${suffix}${sizeStr}`;
			});
			return {
				path: normalized,
				count: entries.length,
				entries: formatted,
			};
		},
	});
}

