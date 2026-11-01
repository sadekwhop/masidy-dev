import { describe, expect, it } from 'bun:test';
import type { FileInfo } from '@cloudflare/shell';
import {
	createSpaceListTool,
	createSpaceWriteTool,
	formatSize,
	getParentDir,
	normalizeWorkspacePath,
} from './workspace-tools';
import type { SpaceWorkspaceOps } from './space-workspace-ops';

describe('normalizeWorkspacePath', () => {
	it('normalizes relative root files to start with slash', () => {
		expect(normalizeWorkspacePath('wrangler.json')).toBe('/wrangler.json');
		expect(normalizeWorkspacePath('package.json')).toBe('/package.json');
		expect(normalizeWorkspacePath('README.md')).toBe('/README.md');
	});

	it('preserves already slash-prefixed paths', () => {
		expect(normalizeWorkspacePath('/wrangler.json')).toBe('/wrangler.json');
		expect(normalizeWorkspacePath('/src/index.ts')).toBe('/src/index.ts');
	});

	it('resolves relative directory traversal and extra slashes', () => {
		expect(normalizeWorkspacePath('src/../src/index.ts')).toBe('/src/index.ts');
		expect(normalizeWorkspacePath('./public/index.html')).toBe('/public/index.html');
		expect(normalizeWorkspacePath('///src//components/Button.tsx')).toBe('/src/components/Button.tsx');
		expect(normalizeWorkspacePath('/')).toBe('/');
		expect(normalizeWorkspacePath('')).toBe('/');
	});
});

describe('getParentDir', () => {
	it('returns / for root files', () => {
		expect(getParentDir('/wrangler.json')).toBe('/');
		expect(getParentDir('/package.json')).toBe('/');
		expect(getParentDir('/index.html')).toBe('/');
	});

	it('returns parent folder for nested files', () => {
		expect(getParentDir('/src/index.ts')).toBe('/src');
		expect(getParentDir('/public/assets/logo.png')).toBe('/public/assets');
	});
});

describe('formatSize', () => {
	it('formats bytes, KB, and MB correctly', () => {
		expect(formatSize(100)).toBe('100 B');
		expect(formatSize(2048)).toBe('2.0 KB');
		expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
	});
});

describe('createSpaceWriteTool', () => {
	it('does NOT call mkdir on root-level files like wrangler.json', async () => {
		const mkdirCalls: string[] = [];
		const writeCalls: Array<{ path: string; content: string }> = [];

		const mockOps: Partial<SpaceWorkspaceOps> = {
			stat: async () => null,
			mkdir: async (path) => {
				mkdirCalls.push(path);
			},
			writeFile: async (path, content) => {
				writeCalls.push({ path, content });
			},
		};

		const writeTool = createSpaceWriteTool({ ops: mockOps as SpaceWorkspaceOps });

		// Writing relative "wrangler.json" should NOT call ops.mkdir("wrangler.json")
		const result = (await (writeTool as any).execute({
			path: 'wrangler.json',
			content: '{"name": "test"}',
		})) as { path: string; bytesWritten: number; lines: number };

		expect(mkdirCalls).toEqual([]);
		expect(writeCalls).toEqual([{ path: '/wrangler.json', content: '{"name": "test"}' }]);
		expect(result.path).toBe('/wrangler.json');
	});

	it('creates parent directory for nested files', async () => {
		const mkdirCalls: string[] = [];
		const writeCalls: Array<{ path: string; content: string }> = [];

		const mockOps: Partial<SpaceWorkspaceOps> = {
			stat: async () => null,
			mkdir: async (path) => {
				mkdirCalls.push(path);
			},
			writeFile: async (path, content) => {
				writeCalls.push({ path, content });
			},
		};

		const writeTool = createSpaceWriteTool({ ops: mockOps as SpaceWorkspaceOps });

		await (writeTool as any).execute({
			path: 'src/index.ts',
			content: 'console.log("hello");',
		});

		expect(mkdirCalls).toEqual(['/src']);
		expect(writeCalls).toEqual([{ path: '/src/index.ts', content: 'console.log("hello");' }]);
	});

	it('self-heals: removes pre-existing directory when writing a file to that path', async () => {
		const rmCalls: Array<{ path: string; opts?: unknown }> = [];
		const writeCalls: Array<{ path: string; content: string }> = [];

		const mockOps: Partial<SpaceWorkspaceOps> = {
			stat: async (path) => {
				if (path === '/wrangler.json') {
					return {
						name: 'wrangler.json',
						path: '/wrangler.json',
						type: 'directory',
						size: 0,
						mimeType: 'inode/directory',
						createdAt: 0,
						updatedAt: 0,
					} as FileInfo;
				}
				return null;
			},
			rm: async (path, opts) => {
				rmCalls.push({ path, opts });
			},
			writeFile: async (path, content) => {
				writeCalls.push({ path, content });
			},
		};

		const writeTool = createSpaceWriteTool({ ops: mockOps as SpaceWorkspaceOps });

		await (writeTool as any).execute({
			path: 'wrangler.json',
			content: '{"main": "src/index.ts"}',
		});

		expect(rmCalls).toEqual([{ path: '/wrangler.json', opts: { recursive: true, force: true } }]);
		expect(writeCalls).toEqual([
			{ path: '/wrangler.json', content: '{"main": "src/index.ts"}' },
		]);
	});
});

describe('createSpaceListTool', () => {
	it('returns clear error when listing a file instead of misleading empty array', async () => {
		let readDirCalled = false;
		const mockOps: Partial<SpaceWorkspaceOps> = {
			stat: async (path) => {
				if (path === '/wrangler.json') {
					return {
						name: 'wrangler.json',
						path: '/wrangler.json',
						type: 'file',
						size: 150,
						mimeType: 'application/json',
						createdAt: 0,
						updatedAt: 0,
					} as FileInfo;
				}
				return null;
			},
			readDir: async () => {
				readDirCalled = true;
				return [];
			},
		};

		const listTool = createSpaceListTool({ ops: mockOps as SpaceWorkspaceOps });

		const result = (await (listTool as any).execute({
			path: 'wrangler.json',
		})) as { error?: string };

		expect(readDirCalled).toBe(false);
		expect(result.error).toContain("'/wrangler.json' is a file (150 B), not a directory");
	});

	it('returns error when directory is not found', async () => {
		const mockOps: Partial<SpaceWorkspaceOps> = {
			stat: async () => null,
			readDir: async () => [],
		};

		const listTool = createSpaceListTool({ ops: mockOps as SpaceWorkspaceOps });

		const result = (await (listTool as any).execute({
			path: '/nonexistent',
		})) as { error?: string };

		expect(result.error).toBe('Directory not found: /nonexistent');
	});

	it('lists directories properly with trailing slash for subdirs and formatted size for files', async () => {
		const mockOps: Partial<SpaceWorkspaceOps> = {
			stat: async (path) => {
				if (path === '/') {
					return {
						name: '',
						path: '/',
						type: 'directory',
						size: 0,
						mimeType: 'inode/directory',
						createdAt: 0,
						updatedAt: 0,
					} as FileInfo;
				}
				return null;
			},
			readDir: async () => [
				{
					name: 'src',
					path: '/src',
					type: 'directory',
					size: 0,
					mimeType: 'inode/directory',
					createdAt: 0,
					updatedAt: 0,
				} as FileInfo,
				{
					name: 'wrangler.json',
					path: '/wrangler.json',
					type: 'file',
					size: 256,
					mimeType: 'application/json',
					createdAt: 0,
					updatedAt: 0,
				} as FileInfo,
			],
		};

		const listTool = createSpaceListTool({ ops: mockOps as SpaceWorkspaceOps });

		const result = (await (listTool as any).execute({
			path: '/',
		})) as { path: string; count: number; entries: string[] };

		expect(result.count).toBe(2);
		expect(result.entries).toEqual(['src/', 'wrangler.json (256 B)']);
	});
});

describe('createSpaceWorkspaceOps', () => {
	it('blocks accidental mkdir on file-like paths', async () => {
		const mkdirCalls: string[] = [];
		const mockStub = {
			mkdir: async (path: string) => {
				mkdirCalls.push(path);
			},
		};

		const ops = (await import('./space-workspace-ops')).createSpaceWorkspaceOps(() => mockStub as any);

		await ops.mkdir('wrangler.json');
		await ops.mkdir('/wrangler.json');
		await ops.mkdir('src/index.ts');
		await ops.mkdir('/public/app.js');
		expect(mkdirCalls).toEqual([]);

		await ops.mkdir('src');
		await ops.mkdir('/public');
		expect(mkdirCalls).toEqual(['/src', '/public']);
	});

	it('normalizes paths for readFile, writeFile, and stat', async () => {
		const readCalls: string[] = [];
		const writeCalls: Array<{ path: string; content: string }> = [];
		const statCalls: string[] = [];

		const mockStub = {
			readFile: async (path: string) => {
				readCalls.push(path);
				return '{}';
			},
			writeFile: async (path: string, content: string) => {
				writeCalls.push({ path, content });
			},
			stat: async (path: string) => {
				statCalls.push(path);
				return null;
			},
		};

		const ops = (await import('./space-workspace-ops')).createSpaceWorkspaceOps(() => mockStub as any);

		await ops.readFile('wrangler.json');
		expect(readCalls).toEqual(['/wrangler.json']);

		await ops.writeFile('wrangler.json', '{}');
		expect(writeCalls).toEqual([{ path: '/wrangler.json', content: '{}' }]);

		await ops.stat('wrangler.json');
		expect(statCalls).toEqual(['/wrangler.json']);
	});
});
