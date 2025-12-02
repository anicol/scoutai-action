import * as core from '@actions/core';
import { chromium } from 'playwright';

export interface PageContext {
  url: string;
  title: string;
  html: string;
  links: LinkInfo[];
  forms: FormInfo[];
  buttons: ButtonInfo[];
  inputs: InputInfo[];
}

export interface LinkInfo {
  href: string;
  text: string;
  selector: string;
}

export interface FormInfo {
  action: string;
  method: string;
  selector: string;
  inputs: InputInfo[];
}

export interface ButtonInfo {
  text: string;
  type: string;
  selector: string;
}

export interface InputInfo {
  name: string;
  type: string;
  placeholder: string;
  selector: string;
  label?: string;
}

/**
 * Crawl a page and extract structured information about interactive elements.
 * This gives Claude real context about what's on the page.
 */
export async function crawlPage(url: string): Promise<PageContext> {
  core.info(`Crawling ${url} to discover page structure...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    const title = await page.title();

    // Get simplified HTML (remove scripts, styles, etc.)
    const html = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;

      // Remove non-essential elements
      const toRemove = clone.querySelectorAll('script, style, noscript, iframe, svg, link[rel="stylesheet"]');
      toRemove.forEach(el => el.remove());

      // Limit size - get just the body content
      const body = clone.querySelector('body');
      if (body) {
        // Truncate to ~50KB to avoid token limits
        let html = body.innerHTML;
        if (html.length > 50000) {
          html = html.substring(0, 50000) + '<!-- truncated -->';
        }
        return html;
      }
      return clone.innerHTML.substring(0, 50000);
    });

    // Extract links
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map((a, i) => {
        const href = a.getAttribute('href') || '';
        const text = a.textContent?.trim().substring(0, 50) || '';

        // Generate a reliable selector
        let selector = '';
        if (a.getAttribute('data-testid')) {
          selector = `[data-testid="${a.getAttribute('data-testid')}"]`;
        } else if (a.id) {
          selector = `#${a.id}`;
        } else if (href && !href.startsWith('javascript:')) {
          selector = `a[href="${href}"]`;
        } else if (text) {
          selector = `a:has-text("${text.substring(0, 30)}")`;
        } else {
          selector = `a >> nth=${i}`;
        }

        return { href, text, selector };
      });
    });

    // Extract forms
    const forms = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('form')).slice(0, 10).map((form, i) => {
        const action = form.getAttribute('action') || '';
        const method = form.getAttribute('method') || 'get';

        let selector = '';
        if (form.getAttribute('data-testid')) {
          selector = `[data-testid="${form.getAttribute('data-testid')}"]`;
        } else if (form.id) {
          selector = `#${form.id}`;
        } else if (form.getAttribute('name')) {
          selector = `form[name="${form.getAttribute('name')}"]`;
        } else {
          selector = `form >> nth=${i}`;
        }

        const inputs = Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 10).map((input, j) => {
          const name = input.getAttribute('name') || '';
          const type = input.getAttribute('type') || (input.tagName === 'TEXTAREA' ? 'textarea' : 'text');
          const placeholder = input.getAttribute('placeholder') || '';
          const inputId = input.id || '';

          // Try to find associated label first (most stable selector)
          let label = '';
          if (inputId) {
            const labelEl = document.querySelector(`label[for="${inputId}"]`);
            if (labelEl) label = labelEl.textContent?.trim().substring(0, 30) || '';
          }
          // Also check parent label
          if (!label) {
            const parentLabel = input.closest('label');
            if (parentLabel) label = parentLabel.textContent?.trim().substring(0, 30) || '';
          }

          // Build selector - prefer stable attributes over IDs (React IDs like :r2: are unstable)
          let inputSelector = '';
          if (input.getAttribute('data-testid')) {
            inputSelector = `[data-testid="${input.getAttribute('data-testid')}"]`;
          } else if (name) {
            inputSelector = `[name="${name}"]`;
          } else if (placeholder) {
            inputSelector = `[placeholder="${placeholder}"]`;
          } else if (label) {
            // Use label text for getByLabel style selector
            inputSelector = `text="${label}" >> .. >> input`;
          } else if (type === 'email') {
            inputSelector = `input[type="email"]`;
          } else if (type === 'password') {
            inputSelector = `input[type="password"]`;
          } else if (inputId && !inputId.includes(':')) {
            // Only use ID if it doesn't contain special CSS characters
            inputSelector = `#${inputId}`;
          } else if (type && type !== 'hidden') {
            // Fall back to type-based selector within form context
            inputSelector = `${selector} input[type="${type}"]`;
          }

          // Last resort: use nth selector within form
          if (!inputSelector && type !== 'hidden') {
            inputSelector = `${selector} input >> nth=${j}`;
          }

          return { name, type, placeholder, selector: inputSelector, label };
        }).filter(i => i.type !== 'hidden');

        return { action, method, selector, inputs };
      });
    });

    // Extract buttons
    const buttons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
        .slice(0, 20)
        .map((btn, i) => {
          const text = btn.textContent?.trim().substring(0, 50) || btn.getAttribute('value') || '';
          const type = btn.getAttribute('type') || 'button';

          let selector = '';
          if (btn.getAttribute('data-testid')) {
            selector = `[data-testid="${btn.getAttribute('data-testid')}"]`;
          } else if (btn.id) {
            selector = `#${btn.id}`;
          } else if (text) {
            selector = `button:has-text("${text.substring(0, 30)}")`;
          } else {
            selector = `button >> nth=${i}`;
          }

          return { text, type, selector };
        })
        .filter(b => b.text || b.selector);
    });

    // Extract standalone inputs (not in forms)
    const inputs = await page.evaluate(() => {
      const formInputs = new Set(
        Array.from(document.querySelectorAll('form input, form textarea, form select'))
      );

      return Array.from(document.querySelectorAll('input, textarea, select'))
        .filter(el => !formInputs.has(el))
        .slice(0, 10)
        .map((el) => {
          const input = el as HTMLInputElement;
          const name = input.getAttribute('name') || '';
          const type = input.getAttribute('type') || 'text';
          const placeholder = input.getAttribute('placeholder') || '';
          const inputId = input.id || '';

          // Prefer stable selectors over IDs
          let selector = '';
          if (input.getAttribute('data-testid')) {
            selector = `[data-testid="${input.getAttribute('data-testid')}"]`;
          } else if (name) {
            selector = `[name="${name}"]`;
          } else if (placeholder) {
            selector = `[placeholder="${placeholder}"]`;
          } else if (type === 'email') {
            selector = `input[type="email"]`;
          } else if (type === 'password') {
            selector = `input[type="password"]`;
          } else if (inputId && !inputId.includes(':')) {
            // Only use ID if it doesn't contain special CSS characters
            selector = `#${inputId}`;
          }

          return { name, type, placeholder, selector };
        })
        .filter(i => i.type !== 'hidden' && i.selector);
    });

    core.info(`Found: ${links.length} links, ${forms.length} forms, ${buttons.length} buttons, ${inputs.length} inputs`);

    return {
      url,
      title,
      html,
      links,
      forms,
      buttons,
      inputs,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Crawl multiple pages to build a site map.
 */
export async function crawlSite(baseUrl: string, maxPages: number = 5): Promise<PageContext[]> {
  const visited = new Set<string>();
  const results: PageContext[] = [];
  const toVisit = [baseUrl];

  while (toVisit.length > 0 && results.length < maxPages) {
    const url = toVisit.shift()!;

    // Normalize URL
    const normalizedUrl = new URL(url, baseUrl).href;
    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    try {
      const pageContext = await crawlPage(normalizedUrl);
      results.push(pageContext);

      // Add internal links to visit queue
      for (const link of pageContext.links) {
        if (link.href.startsWith('/') || link.href.startsWith(baseUrl)) {
          const fullUrl = new URL(link.href, baseUrl).href;
          if (!visited.has(fullUrl) && !toVisit.includes(fullUrl)) {
            toVisit.push(fullUrl);
          }
        }
      }
    } catch (error) {
      core.warning(`Failed to crawl ${normalizedUrl}: ${error}`);
    }
  }

  return results;
}
