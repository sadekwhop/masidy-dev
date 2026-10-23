/**
 * Stripe Utilities for Cloudflare Workers
 * Web Crypto HMAC-SHA256 signature verification and helpers.
 */

const timingSafeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
};

/**
 * Verifies the `stripe-signature` header using Web Crypto HMAC-SHA256.
 * Zero external dependencies; 100% Cloudflare Workers native.
 */
export async function verifyStripeWebhookSignature(
	body: string,
	header: string,
	secret: string,
): Promise<boolean> {
	try {
		const pairs = header.split(',').map((p) => p.trim());
		const timestampItem = pairs.find((p) => p.startsWith('t='));
		if (!timestampItem) return false;
		const timestamp = timestampItem.slice(2);

		const v1Signatures = pairs
			.filter((p) => p.startsWith('v1='))
			.map((p) => p.slice(3))
			.filter((sig) => sig.length > 0);

		if (v1Signatures.length === 0) return false;

		// Reject if timestamp is older than 5 minutes (300 seconds)
		if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

		const enc = new TextEncoder();
		const k = await crypto.subtle.importKey(
			'raw',
			enc.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const mac = await crypto.subtle.sign(
			'HMAC',
			k,
			enc.encode(`${timestamp}.${body}`),
		);
		const hex = [...new Uint8Array(mac)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		return v1Signatures.some((sig) => timingSafeEqual(hex, sig));
	} catch {
		return false;
	}
}
