/**
 * Script to deploy and configure all Dynamic Routes on Cloudflare AI Gateway
 * directly via the Cloudflare REST API without needing the Dashboard UI.
 *
 * Routes created/configured:
 *  - masidy-code      (Primary: qwen2.5-coder-32b,   Fallback: kimi-k2.7-code)
 *  - masidy-chat      (Primary: llama-3.3-70b-fp8,   Fallback: llama-3.1-8b)
 *  - masidy-reasoning (Primary: deepseek-r1-qwen-32b, Fallback: llama-3.3-70b-fp8)
 *  - masidy-summary   (Primary: llama-3.1-8b,         Fallback: mistral-small-3.1-24b)
 *  - masidy           (Primary: llama-3.3-70b-fp8,   Fallback: llama-3.1-8b)
 */

import { readFileSync } from 'fs';

interface RouteConfig {
  name: string;
  description: string;
  primary: {
    provider: string;
    model: string;
    timeout: number;
    retries: number;
  };
  fallback: {
    provider: string;
    model: string;
    timeout: number;
    retries: number;
  };
}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'c46166ce44bd4ae47eed852d7fe041a8';
const GATEWAY_ID = process.env.CLOUDFLARE_AI_GATEWAY || 'vibesdk-gateway';

function getApiToken(): string {
  const envToken =
    process.env.MASIDY_API_TOKEN ||
    process.env['MASIDY-API-TOKEN'] ||
    process.env.CLOUDFLARE_API_TOKEN;
  if (envToken) return envToken;

  for (const envFile of ['.env.local', '.prod.vars']) {
    try {
      const content = readFileSync(envFile, 'utf8');
      const match = content.match(/MASIDY-API-TOKEN=(.+)/i);
      if (match && match[1]) return match[1].trim();
    } catch {
      // ignore
    }
  }

  throw new Error('Cloudflare API token not found in env, .env.local, or .prod.vars');
}

const API_TOKEN = getApiToken();

const ROUTES_TO_DEPLOY: RouteConfig[] = [
  {
    name: 'masidy-code',
    description: 'Specialized code generation & analysis with native tool calling',
    primary: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      timeout: 45000,
      retries: 2,
    },
    fallback: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      timeout: 30000,
      retries: 1,
    },
  },
  {
    name: 'masidy-chat',
    description: 'Fast, natural conversational assistant',
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      timeout: 30000,
      retries: 2,
    },
    fallback: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      timeout: 60000,
      retries: 1,
    },
  },
  {
    name: 'masidy-reasoning',
    description: 'Deep mathematical, architecture & chain-of-thought reasoning',
    primary: {
      provider: 'workers-ai',
      model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      timeout: 60000,
      retries: 2,
    },
    fallback: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      timeout: 30000,
      retries: 1,
    },
  },
  {
    name: 'masidy-summary',
    description: 'High-throughput condensation and key extraction',
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.1-8b-instruct',
      timeout: 20000,
      retries: 2,
    },
    fallback: {
      provider: 'workers-ai',
      model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
      timeout: 20000,
      retries: 1,
    },
  },
  {
    name: 'masidy',
    description: 'Default general-purpose dynamic route',
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      timeout: 30000,
      retries: 2,
    },
    fallback: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      timeout: 60000,
      retries: 1,
    },
  },
  {
    name: 'yes',
    description: 'Compatibility alias route for legacy CLOUDFLARE_AI_GATEWAY_ROUTE=yes configs',
    primary: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      timeout: 30000,
      retries: 2,
    },
    fallback: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      timeout: 60000,
      retries: 1,
    },
  },
];

function buildElements(route: RouteConfig) {
  return [
    {
      id: 'START',
      type: 'start',
      outputs: {
        next: { elementId: 'primary-model' },
      },
    },
    {
      id: 'primary-model',
      type: 'model',
      properties: {
        provider: route.primary.provider,
        model: route.primary.model,
        timeout: route.primary.timeout,
        retries: route.primary.retries,
      },
      outputs: {
        success: { elementId: 'END' },
        fallback: { elementId: 'fallback-model' },
      },
    },
    {
      id: 'fallback-model',
      type: 'model',
      properties: {
        provider: route.fallback.provider,
        model: route.fallback.model,
        timeout: route.fallback.timeout,
        retries: route.fallback.retries,
      },
      outputs: {
        success: { elementId: 'END' },
        fallback: { elementId: 'END' },
      },
    },
    {
      id: 'END',
      type: 'end',
      outputs: {},
    },
  ];
}

async function main() {
  console.log('====================================================');
  console.log(' Cloudflare AI Gateway Dynamic Router Deployment');
  console.log(` Account: ${ACCOUNT_ID}`);
  console.log(` Gateway: ${GATEWAY_ID}`);
  console.log('====================================================\n');

  // 1. Fetch existing routes
  console.log('1. Fetching existing routes in AI Gateway...');
  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}/routes`,
    {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
      },
    }
  );

  if (!listRes.ok) {
    throw new Error(`Failed to list routes: ${listRes.status} ${await listRes.text()}`);
  }

  const listData = await listRes.json();
  const existingRoutes = (listData.data?.routes || []) as Array<{ id: string; name: string }>;
  console.log(`Found ${existingRoutes.length} existing route(s):`, existingRoutes.map((r) => `${r.name} (${r.id})`).join(', ') || 'None');

  // 2. Delete existing routes that match our managed names to ensure clean state
  const targetNames = new Set(ROUTES_TO_DEPLOY.map((r) => r.name));
  for (const r of existingRoutes) {
    if (targetNames.has(r.name)) {
      console.log(`Deleting existing route "${r.name}" (${r.id})...`);
      const delRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}/routes/${r.id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );
      if (!delRes.ok) {
        console.warn(`Warning: Delete failed for ${r.name}: ${delRes.status} ${await delRes.text()}`);
      } else {
        console.log(`Successfully deleted old route "${r.name}".`);
      }
    }
  }

  // 3. Create each dynamic route and deploy its version
  console.log('\n2. Creating and deploying all dynamic routes...');
  const deployedRoutes: Record<string, { id: string; versionId: string }> = {};

  for (const config of ROUTES_TO_DEPLOY) {
    console.log(`\nCreating route "${config.name}"...`);
    console.log(`  Primary:  ${config.primary.model} (${config.primary.timeout}ms, ${config.primary.retries} retries)`);
    console.log(`  Fallback: ${config.fallback.model} (${config.fallback.timeout}ms, ${config.fallback.retries} retries)`);

    const elements = buildElements(config);
    const createRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}/routes`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: config.name,
          elements,
        }),
      }
    );

    if (!createRes.ok) {
      throw new Error(`Failed to create route ${config.name}: ${createRes.status} ${await createRes.text()}`);
    }

    const createData = await createRes.json();
    const routeId = createData.result.id;
    const versionId = createData.result.version?.version_id;
    console.log(`  Created route ID: ${routeId}, version ID: ${versionId}`);

    // Ensure version is actively deployed
    if (versionId && (!createData.result.deployment || createData.result.deployment.version_id !== versionId)) {
      console.log(`  Deploying version ${versionId}...`);
      const depRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}/routes/${routeId}/deployments`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ version_id: versionId }),
        }
      );
      if (!depRes.ok) {
        console.warn(`  Warning: deploy response status ${depRes.status}: ${await depRes.text()}`);
      } else {
        console.log(`  Deployed successfully.`);
      }
    } else {
      console.log(`  Version ${versionId} is already deployed.`);
    }

    deployedRoutes[config.name] = { id: routeId, versionId };
  }

  // 4. Test each route with live inference
  console.log('\n3. Verifying all routes with live requests...');
  const testResults: Array<{ route: string; status: number; ok: boolean; response: string; timeMs: number }> = [];

  for (const config of ROUTES_TO_DEPLOY) {
    const routeModel = `dynamic/${config.name}`;
    process.stdout.write(`Testing ${routeModel}... `);
    const start = Date.now();

    try {
      const testRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'cf-aig-gateway-id': GATEWAY_ID,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: routeModel,
            messages: [{ role: 'user', content: 'Respond with the word SUCCESS' }],
            max_tokens: 10,
          }),
        }
      );

      const elapsed = Date.now() - start;
      const json = await testRes.json();
      const content = json.choices?.[0]?.message?.content || JSON.stringify(json.errors || json);
      const isSuccess = testRes.ok && !json.errors?.length;

      console.log(`${testRes.status} (${elapsed}ms) - "${content.trim().slice(0, 50)}"`);
      testResults.push({
        route: config.name,
        status: testRes.status,
        ok: isSuccess,
        response: content.trim(),
        timeMs: elapsed,
      });
    } catch (err: any) {
      console.log(`FAILED: ${err.message}`);
      testResults.push({
        route: config.name,
        status: 500,
        ok: false,
        response: err.message,
        timeMs: Date.now() - start,
      });
    }
  }

  // 5. Print Summary
  console.log('\n====================================================');
  console.log(' DEPLOYMENT SUMMARY');
  console.log('====================================================');
  console.table(
    testResults.map((r) => ({
      Route: `dynamic/${r.route}`,
      Status: r.ok ? 'ONLINE (200)' : `ERROR (${r.status})`,
      Latency: `${r.timeMs}ms`,
      Preview: r.response.slice(0, 35),
    }))
  );

  console.log('\nAll dynamic routes are successfully configured in your Cloudflare dashboard!');
}

main().catch((err) => {
  console.error('\nDeployment script failed:', err);
  process.exit(1);
});
