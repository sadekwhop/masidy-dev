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
			requestFailures.push({
				url: req.url(),
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
				requestFailures.push({
					url: res.url(),
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

  // 1. Low contrast on primary CTA buttons and link text
  const ctaSelectors = 'button, a[href], [role="button"], input[type="submit"], input[type="button"]';
  document.querySelectorAll(ctaSelectors).forEach(function(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const color = cssColorToHex(style.color);
      const bg = cssColorToHex(style.backgroundColor);
      if (!color || !bg) return;
      const ratio = contrastRatio(color, bg);
      if (ratio < 3.0) {
        issues.push({ type: 'low_contrast', message: 'Text contrast ratio ' + ratio.toFixed(1) + ':1 is below 3.0 (WCAG AA requires 4.5:1 for normal text)', selector: selector(el) });
      }
    } catch {}
  });

  // 2. Interactive elements with zero computed size or display:none
  document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]').forEach(function(el) {
    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === 'none') {
        issues.push({ type: 'zero_size_interactive', message: 'Interactive element is display:none (not visible to users)', selector: selector(el) });
        return;
      }
      if (rect.width < 1 && rect.height < 1) {
        issues.push({ type: 'zero_size_interactive', message: 'Interactive element has zero computed size (' + rect.width.toFixed(0) + 'x' + rect.height.toFixed(0) + 'px)', selector: selector(el) });
      }
    } catch {}
  });

  // 3. Forms with no visible submit button
  document.querySelectorAll('form').forEach(function(form) {
    try {
      const submits = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"], [role="button"]');
      const visible = Array.from(submits).some(function(el) {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!visible) {
        issues.push({ type: 'form_no_submit', message: 'Form has no visible submit button', selector: selector(form) });
      }
    } catch {}
  });

  // 4. Content touching the viewport edge (left/right padding < 8px on body/main containers)
  var containers = [document.body, document.querySelector('main'), document.querySelector('[class*="container"]'), document.querySelector('[class*="wrapper"]')].filter(Boolean);
  containers.forEach(function(el) {
    try {
      const style = window.getComputedStyle(el);
      const pl = parseFloat(style.paddingLeft);
      const pr = parseFloat(style.paddingRight);
      if ((pl < 8 || pr < 8) && el.scrollWidth >= vw) {
        issues.push({ type: 'content_touching_edge', message: 'Container has very small horizontal padding (left:' + pl.toFixed(0) + 'px right:' + pr.toFixed(0) + 'px) — content may touch viewport edge on mobile', selector: selector(el) });
      }
    } catch {}
  });

  // 5. Horizontal overflow
  try {
    const bodyWidth = document.body.scrollWidth;
    if (bodyWidth > vw + 4) {
      // Find the widest offending child
      var worst = null; var worstW = 0;
      document.querySelectorAll('*').forEach(function(el) {
        try {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 4 && r.width > worstW) { worst = el; worstW = r.width; }
        } catch {}
      });
      issues.push({ type: 'horizontal_overflow', message: 'Page scrolls horizontally (body.scrollWidth=' + bodyWidth + 'px > viewport=' + vw + 'px)' + (worst ? ' — widest offender: ' + selector(worst) : ''), selector: worst ? selector(worst) : undefined });
    }
  } catch {}

  // 6. Images / icons that failed to load
  document.querySelectorAll('img').forEach(function(img) {
    try {
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
