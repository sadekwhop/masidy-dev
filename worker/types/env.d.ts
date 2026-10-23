declare namespace Cloudflare {
	interface Env {
		// Dashboard-managed settings are intentionally omitted from wrangler vars.
		ALLOWED_EMAIL?: string;
		ALLOCATION_STRATEGY?: string;
		ENABLE_ARTIFACTS?: string;
		ENABLE_CLOUDFLARE_LIMITS?: string;
		ENABLE_EMAIL_AUTH?: string;
		ENABLE_READ_REPLICAS?: string;
		ENABLE_USER_ACCOUNT_DEPLOY?: string;
		USE_CLOUDFLARE_IMAGES?: string;
		USE_TUNNEL_FOR_PREVIEW?: string;

		// Secret bindings are omitted by `wrangler types` when absent from .dev.vars.
		AI_PROXY_JWT_SECRET: string;
		ANTHROPIC_API_KEY: string;
		BENCHMARK_MODE: string;
		CF_ACCESS_ID: string;
		CF_ACCESS_SECRET: string;
		CF_OAUTH_ENCRYPTION_KEY: string;
		CLOUDFLARE_ACCOUNT_ID: string;
		CLOUDFLARE_API_TOKEN: string;
		CLOUDFLARE_AI_GATEWAY_TOKEN: string;
		CLOUDFLARE_AI_GATEWAY_URL: string;
		CLOUDFLARE_AI_GATEWAY_ROUTE?: string;
		CF_ACCESS_TEAM_DOMAIN?: string;
		CF_ACCESS_AUD?: string;
		CLOUDFLARE_OAUTH_CLIENT_ID: string;
		CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
		CUSTOM_PREVIEW_DOMAIN: string;
		DISPATCHER?: DispatchNamespace;
		ENVIRONMENT: string;
		GITHUB_EXPORTER_CLIENT_ID: string;
		GITHUB_EXPORTER_CLIENT_SECRET: string;
		GOOGLE_AI_STUDIO_API_KEY: string;
		GOOGLE_CLIENT_ID: string;
		GOOGLE_CLIENT_SECRET: string;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		OPENROUTER_API_KEY: string;
		PLATFORM_MODEL_PROVIDERS: string;
		SANDBOX_SERVICE_API_KEY: string;
		SANDBOX_SERVICE_TYPE: string;
		SANDBOX_SERVICE_URL: string;
		SENTRY_DSN: string;
		SERPAPI_KEY: string;
		JWT_SECRET: string;
		STRIPE_SECRET_KEY?: string;
		STRIPE_WEBHOOK_SECRET?: string;
		BASE_RPC_URL?: string;
		MAX_USER_DEPOSIT_USD?: string;
		ALLOWED_EMAIL?: string;
		TURNSTILE_SECRET_KEY?: string;
	}
}
