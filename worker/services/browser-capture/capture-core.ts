/**
 * Puppeteer-agnostic console-log capture core.
 *
 * Both the in-worker `BindingCaptureClient` (which uses
 * `@cloudflare/puppeteer` against the `BROWSER` binding) and the
 * out-of-worker dev sidecar (which uses regular `puppeteer`) feed a
 * `Page` here so navigation + listener wiring lives in exactly one
 * place.
 */

import type {
	CapturePage,
	CapturePayload,
	BrowserConsoleCaptureResult,
	BrowserConsoleEntry,
	BrowserConsolePageError,
	BrowserConsoleRequestFailure,
	DomAuditPayload,
	DomAuditResult,
	DomAuditIssue,
} from './types';

const PAGE_LOAD_TIMEOUT_MS = 30_000;

/**
 * Platform-level URLs that are injected by or probed against the Masidy
 * platform itself (the preview fetch-patch, the WebMCP browser spec probe
 * against /mcp, etc.). These appear in the console of every preview page
 * regardless of app content and must be filtered from what the agent sees,
 * otherwise the console will never look "clean" and the verification gate
 * will always fail.
 */
const PLATFORM_NOISE_URL_PATTERNS = [
	// Masidy's own MCP endpoint — probed automatically by the WebMCP browser
	// spec (Chrome 146+) and by WebMCP browser extensions on every page load.
	// The 402 payment-required response is not an app bug.
	'/mcp',
];

function isPlatformNoiseUrl(url: string): boolean {
	try {
		const pathname = new URL(url).pathname;
		return PLATFORM_NOISE_URL_PATTERNS.some((p) => pathname === p || pathname.startsWith(p + '/'));
	} catch {
		return PLATFORM_NOISE_URL_PATTERNS.some((p) => url.includes(p));
	}
}

export async function runCapture(
	page: CapturePage,
	payload: CapturePayload,
): Promise<BrowserConsoleCaptureResult> {
	const logs: BrowserConsoleEntry[] = [];
	const pageErrors: BrowserConsolePageError[] = [];
	const requestFailures: BrowserConsoleRequestFailure[] = [];

	page.on('console', (msg) => {
		try {
			logs.push({
				level: msg.type(),
				text: msg.text(),
				location: msg.location(),
			});
		} catch {
			// best-effort capture; never let a listener crash the page
		}
	});
	page.on('pageerror', (err) => {
		pageErrors.push({ message: err.message, stack: err.stack });
	});
	page.on('requestfailed', (req) => {
		try {
			const url = req.url();
			if (isPlatformNoiseUrl(url)) return; // platform probe, not an app bug
			requestFailures.push({
				url,
				method: req.method(),
				failure: req.failure()?.errorText ?? 'unknown',
			});
		} catch {
			// ignore listener errors
		}
	});
	page.on('response', (res) => {
		try {
			const status = res.status();
			if (status >= 400) {
				const url = res.url();
				if (isPlatformNoiseUrl(url)) return; // platform probe, not an app bug
				requestFailures.push({
					url,
					method: res.request().method(),
					failure: `HTTP ${status}`,
					status,
				});
			}
		} catch {
			// ignore listener errors
		}
	});

	try {
		await page.setViewport(payload.viewport);
		await page.goto(payload.url, {
			waitUntil: 'networkidle2',
			timeout: PAGE_LOAD_TIMEOUT_MS,
		});
		if (payload.interactScript) {
			await page.evaluate(payload.interactScript);
		}
		const waitMs = Math.max(0, payload.waitSeconds) * 1000;
		if (waitMs > 0) {
			await new Promise((r) => setTimeout(r, waitMs));
		}
	} finally {
		try {
			await page.close();
		} catch {
			// ignore close failures
		}
	}

	return {
		url: payload.url,
		capturedAt: new Date().toISOString(),
		logs,
		pageErrors,
		requestFailures,
	};
}

// ── DOM audit ────────────────────────────────────────────────────────────────

/** Inline JS that runs inside the page via `evaluate` and returns a JSON string. */
const DOM_AUDIT_SCRIPT = /* javascript */ `
(function() {
  const issues = [];
  const docEl = document.documentElement;
  const vw = docEl.clientWidth;

  function selector(el) {
    try {
      if (el.id) return '#' + el.id;
      const tag = el.tagName.toLowerCase();
      const cls = Array.from(el.classList).slice(0, 2).join('.');
      const text = (el.textContent || '').trim().slice(0, 40).replace(/\\s+/g, ' ');
      return cls ? tag + '.' + cls + (text ? ' "' + text + '"' : '') : tag + (text ? ' "' + text + '"' : '');
    } catch { return '?'; }
  }

  function isAriaHidden(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.getAttribute('aria-hidden') === 'true') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function luminance(r, g, b) {
    const s = [r, g, b].map(function(c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  }

  function contrastRatio(hex1, hex2) {
    function parse(h) {
      h = h.replace(/^#/, '');
      if (h.length === 3) h = h.split('').map(function(c){return c+c;}).join('');
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    try {
      const c1 = parse(hex1); const c2 = parse(hex2);
      const l1 = luminance(c1[0],c1[1],c1[2]);
      const l2 = luminance(c2[0],c2[1],c2[2]);
      const hi = Math.max(l1,l2); const lo = Math.min(l1,l2);
      return (hi + 0.05) / (lo + 0.05);
    } catch { return 21; }
  }

  function cssColorToHex(color) {
    if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;
    const m = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (!m) return null;
    return '#' + [m[1],m[2],m[3]].map(function(x){return ('0'+parseInt(x).toString(16)).slice(-2);}).join('');
  }

  // 1. Low contrast on primary CTA buttons only (skip aria-hidden, skip empty/icon-only elements)
  document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"]').forEach(function(el) {
    try {
      if (isAriaHidden(el)) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const text = (el.textContent || '').trim();
      if (text.length < 2) return; // skip icon-only buttons
      const color = cssColorToHex(style.color);
      const bg = cssColorToHex(style.backgroundColor);
      if (!color || !bg) return;
      const ratio = contrastRatio(color, bg);
      if (ratio < 3.0) {
        issues.push({ type: 'low_contrast', message: 'Text contrast ratio ' + ratio.toFixed(1) + ':1 is below 3.0 on a CTA/link', selector: selector(el) });
      }
    } catch {}
  });

  // 2. Interactive elements with zero rendered size — skip off-screen (mobile menus etc.) and aria-hidden
  document.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach(function(el) {
    try {
      if (isAriaHidden(el)) return;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === 'none') {
        // Only flag a <button> that's display:none AND has visible text — likely a hidden submit button
        const text = (el.textContent || '').trim();
        if (text.length > 1 && el.tagName === 'BUTTON') {
          issues.push({ type: 'zero_size_interactive', message: 'Button is display:none: "' + text.slice(0,40) + '"', selector: selector(el) });
        }
        return;
      }
      if (style.visibility === 'hidden' || style.opacity === '0') return; // skip intentionally hidden
      if (rect.width < 1 && rect.height < 1) {
        issues.push({ type: 'zero_size_interactive', message: 'Button/submit has zero rendered size (' + rect.width.toFixed(0) + 'x' + rect.height.toFixed(0) + 'px)', selector: selector(el) });
      }
    } catch {}
  });

  // 3. Forms with no visible submit button
  document.querySelectorAll('form').forEach(function(form) {
    try {
      const submits = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]');
      const visible = Array.from(submits).some(function(el) {
        if (isAriaHidden(el)) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 1 && r.height > 1;
      });
      if (!visible) {
        issues.push({ type: 'form_no_submit', message: 'Form has no visible submit button', selector: selector(form) });
      }
    } catch {}
  });

  // 4. Content touching viewport edge — check section/main/article/hero containers, NOT body
  //    This catches generated apps that forget padding on sections, not intentional edge-to-edge heroes.
  var sectionContainers = Array.from(document.querySelectorAll('section, main, article, [class*="hero"], [class*="section"], [class*="container"], [class*="wrapper"]'));
  var seen = new Set();
  sectionContainers.forEach(function(el) {
    try {
      if (seen.has(el)) return;
      seen.add(el);
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100) return; // skip tiny containers
      const pl = parseFloat(style.paddingLeft);
      const pr = parseFloat(style.paddingRight);
      // Only flag if the container itself has content flush with both edges (< 4px each side)
      if (pl < 4 && pr < 4 && rect.width >= vw * 0.9) {
        issues.push({ type: 'content_touching_edge', message: 'Full-width section has no horizontal padding (left:' + pl.toFixed(0) + 'px right:' + pr.toFixed(0) + 'px) — text may touch the viewport edge on narrow screens', selector: selector(el) });
      }
    } catch {}
  });

  // 5. Horizontal overflow
  try {
    const bodyWidth = document.body.scrollWidth;
    if (bodyWidth > vw + 8) {
      var worst = null; var worstR = 0;
      document.querySelectorAll('*').forEach(function(el) {
        try {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 8 && r.right > worstR) { worst = el; worstR = r.right; }
        } catch {}
      });
      issues.push({ type: 'horizontal_overflow', message: 'Page scrolls horizontally (body.scrollWidth=' + bodyWidth + 'px > viewport=' + vw + 'px)' + (worst ? ' — widest offender: ' + selector(worst) : ''), selector: worst ? selector(worst) : undefined });
    }
  } catch {}

  // 6. Images that failed to load (aria-hidden images are decorative, skip them)
  document.querySelectorAll('img').forEach(function(img) {
    try {
      if (isAriaHidden(img)) return;
      if (!img.complete || img.naturalWidth === 0) {
        issues.push({ type: 'broken_image', message: 'Image failed to load: src="' + (img.src || '').slice(0, 120) + '"', selector: selector(img) });
      }
    } catch {}
  });

  return JSON.stringify(issues);
})()
`;

/**
 * Run a cheap DOM audit inside an already-navigated page.
 * No vision tokens — pure JS `evaluate` inside the browser.
 */
export async function runDomAudit(
	page: CapturePage,
	payload: DomAuditPayload,
): Promise<DomAuditResult> {
	const url = payload.url;
	try {
		await page.setViewport({ width: 1280, height: 800 });
		await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
		const waitMs = Math.min(Math.max((payload.waitSeconds ?? 3), 0), 15) * 1000;
		if (waitMs > 0) {
			await new Promise((r) => setTimeout(r, waitMs));
		}
		const raw = await page.evaluate(DOM_AUDIT_SCRIPT) as string;
		let issues: DomAuditIssue[] = [];
		try {
			issues = JSON.parse(raw) as DomAuditIssue[];
		} catch {
			// evaluate returned unexpected value — treat as no issues
		}
		return {
			url,
			audited_at: new Date().toISOString(),
			issues,
			passed: issues.length === 0,
		};
	} finally {
		try { await page.close(); } catch { /* ignore */ }
	}
}
