import type { Agent, AgentOut, TeamEnv, ToolName } from './core';
import { textOf, withTimeout } from './core';
import { runTool } from './tools';

const strip = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

const toolHelp = (tools: ToolName[]): string =>
	`You may call tools. To call one, reply with ONLY: <tool>{"name":"<tool>","args":{...}}</tool>
Available: ${tools.map((t) => (t === 'fetch_url' ? 'fetch_url {url}' : `${t} {query}`)).join(', ')}.
Use at most 3 calls, then give the final answer without tool tags.`;

export async function runText(
	env: TeamEnv,
	agent: Agent,
	task: string,
	context: string,
	requestId: string,
): Promise<AgentOut> {
	const system =
		(agent.system ?? '') +
		(agent.tools?.length ? `\n\n${toolHelp(agent.tools)}` : '');
	let lastErr: unknown;

	const gatewayId = env.GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';

	for (let i = 0; i < agent.chain.length; i++) {
		const model = agent.chain[i];
		try {
			const messages: { role: string; content: string }[] = [
				{ role: 'system', content: system },
				{
					role: 'user',
					content: context ? `Context:\n${context}\n\nTask:\n${task}` : task,
				},
			];
			let output = '';
			let calls = 0;

			for (let round = 0; round < 5 && !output; round++) {
				const out = await withTimeout(
					env.AI.run(
						model as Parameters<Ai['run']>[0],
						{ messages, max_tokens: agent.maxTokens } as Parameters<Ai['run']>[1],
						{
							gateway: {
								id: gatewayId,
								metadata: { agent: agent.id, requestId },
							},
						},
					),
					agent.timeoutMs,
				);
				const text = strip(textOf(out));
				if (!text) throw new Error('empty response');

				const m = text.match(/<tool>([\s\S]*?)<\/tool>/);
				if (!m) {
					output = text;
					break;
				}

				if (calls >= 3 || !agent.tools?.length) {
					messages.push(
						{ role: 'assistant', content: text },
						{
							role: 'user',
							content:
								'Tool limit reached. Give the final answer now with no tool tags.',
						},
					);
					continue;
				}
				calls++;
				let result: string;
				try {
					const { name, args } = JSON.parse(m[1]) as {
						name: ToolName;
						args: Record<string, string>;
					};
					result = agent.tools.includes(name)
						? await runTool(
								env.AI,
								env.TEAM_VEC,
								gatewayId,
								env.BRAVE_API_KEY,
								name,
								args,
						  )
						: `tool ${name} not allowed`;
				} catch (e: unknown) {
					const err = e as { message?: string };
					result = `tool error: ${String(err?.message ?? e)}`;
				}
				messages.push(
					{ role: 'assistant', content: text },
					{ role: 'user', content: `Tool result:\n${result.slice(0, 6000)}` },
				);
			}
			if (!output) throw new Error('no final answer');
			return { output, model, usedFallback: i > 0 };
		} catch (e) {
			lastErr = e;
			console.warn(
				JSON.stringify({
					requestId,
					agent: agent.id,
					model,
					ok: false,
					error: String((e as { message?: string })?.message ?? e),
				}),
			);
		}
	}
	throw lastErr ?? new Error('all models failed');
}
