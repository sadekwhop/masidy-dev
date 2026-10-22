import type { Agent, AgentOut, TeamEnv } from './core';
import { b64ToBytes, bytesToB64, withTimeout } from './core';

export async function runImage(
	env: TeamEnv,
	agent: Agent,
	prompt: string,
	requestId: string,
): Promise<AgentOut> {
	if (!env.TEAM_FILES) {
		throw new Error('Image storage is not configured (TEAM_FILES R2 bucket missing)');
	}
	const gatewayId = env.GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';
	const publicBaseUrl =
		env.PUBLIC_BASE_URL ||
		(env.CUSTOM_DOMAIN ? `https://${env.CUSTOM_DOMAIN}` : 'http://localhost:5173');

	let lastErr: unknown;
	for (let i = 0; i < agent.chain.length; i++) {
		const model = agent.chain[i];
		try {
			const out = (await withTimeout(
				env.AI.run(
					model as Parameters<Ai['run']>[0],
					{ prompt, ...(i === 0 ? { steps: 4 } : {}) } as Parameters<Ai['run']>[1],
					{
						gateway: {
							id: gatewayId,
							metadata: { agent: agent.id, requestId },
						},
					},
				),
				agent.timeoutMs,
			)) as { image?: string } | ReadableStream;

			let bytes: Uint8Array;
			let type = 'image/jpeg';
			if (out && typeof out === 'object' && 'image' in out && typeof out.image === 'string') {
				bytes = b64ToBytes(out.image);
			} else if (out instanceof ReadableStream) {
				bytes = new Uint8Array(await new Response(out).arrayBuffer());
				type = 'image/png';
			} else {
				throw new Error('unexpected image output');
			}

			const key = `img/${crypto.randomUUID()}.${type === 'image/png' ? 'png' : 'jpg'}`;
			await env.TEAM_FILES.put(key, bytes, {
				httpMetadata: { contentType: type },
			});
			return {
				output: `${publicBaseUrl}/team/v1/files/${key}`,
				model,
				usedFallback: i > 0,
			};
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error('image generation failed');
}

export async function transcribe(
	env: TeamEnv,
	audio: ArrayBuffer,
): Promise<string> {
	const gatewayId = env.GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';
	const out = (await env.AI.run(
		'@cf/openai/whisper-large-v3-turbo' as Parameters<Ai['run']>[0],
		{ audio: bytesToB64(new Uint8Array(audio)) } as Parameters<Ai['run']>[1],
		{ gateway: { id: gatewayId, metadata: { agent: 'stt' } } },
	)) as { text?: string };
	return out?.text ?? '';
}

export async function speak(
	env: TeamEnv,
	text: string,
	lang = 'en',
): Promise<string> {
	if (!env.TEAM_FILES) {
		throw new Error('Audio storage is not configured (TEAM_FILES R2 bucket missing)');
	}
	const gatewayId = env.GATEWAY_ID || env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';
	const publicBaseUrl =
		env.PUBLIC_BASE_URL ||
		(env.CUSTOM_DOMAIN ? `https://${env.CUSTOM_DOMAIN}` : 'http://localhost:5173');

	const out = (await env.AI.run(
		'@cf/myshell-ai/melotts' as Parameters<Ai['run']>[0],
		{ prompt: text, lang } as Parameters<Ai['run']>[1],
		{ gateway: { id: gatewayId, metadata: { agent: 'tts' } } },
	)) as { audio?: string };
	if (!out?.audio) throw new Error('tts failed');

	const key = `audio/${crypto.randomUUID()}.mp3`;
	await env.TEAM_FILES.put(key, b64ToBytes(out.audio), {
		httpMetadata: { contentType: 'audio/mpeg' },
	});
	return `${publicBaseUrl}/team/v1/files/${key}`;
}
