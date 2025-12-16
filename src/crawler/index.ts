import * as core from '@actions/core';
import { chromium, BrowserContext, Page } from 'playwright';

/**
 * Credentials for authenticating during crawl.
 */
export interface CrawlCredentials {
  email: string;
  password: string;
  loginUrl: string;
  emailSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successIndicator?: string;
}

/**
 * Result of authentication attempt.
 */
export interface AuthResult {
  success: boolean;
  postLoginUrl?: string;
  error?: string;
}

/**
 * Result of a site crawl including auth status.
 */
export interface CrawlResult {
  pages: PageContext[];
  authResult?: AuthResult;
}

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
 * Authenticate using the provided credentials.
 * Returns AuthResult with success status, post-login URL, and any error message.
 */
async function authenticate(
  context: BrowserContext,
  baseUrl: string,
  credentials: CrawlCredentials
): Promise<AuthResult> {
  const page = await context.newPage();

  try {
    // Navigate to login page
    let loginUrl = credentials.loginUrl;
    if (!loginUrl.startsWith('http')) {
      loginUrl = new URL(loginUrl, baseUrl).href;
    }

    core.info(`Authenticating at ${loginUrl}...`);
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 15000 });

    // Fill email - use configured selector or try common patterns
    const emailSelector = credentials.emailSelector ||
      'input[type="email"], input[name="email"], input[id="email"], [placeholder*="email" i]';
    await page.locator(emailSelector).first().fill(credentials.email, { timeout: 5000 });

    // Fill password
    const passwordSelector = credentials.passwordSelector ||
      'input[type="password"], input[name="password"], input[id="password"]';
    await page.locator(passwordSelector).first().fill(credentials.password, { timeout: 5000 });

    // Submit form
    const submitSelector = credentials.submitSelector ||
      'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")';

    // Get current URL before clicking to detect navigation
    const preLoginUrl = page.url();

    await page.locator(submitSelector).first().click({ timeout: 5000 });

    // Wait for navigation/login to complete
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Verify login succeeded if indicator is configured
    if (credentials.successIndicator) {
      if (credentials.successIndicator.startsWith('/')) {
        // URL pattern
        await page.waitForURL(`**${credentials.successIndicator}*`, { timeout: 10000 });
      } else {
        // Selector
        await page.locator(credentials.successIndicator).waitFor({ state: 'visible', timeout: 10000 });
      }
    } else {
      // No indicator configured - wait for URL to change from login page
      try {
        await page.waitForURL(
          (url) => url.href !== preLoginUrl && !url.href.includes('/login') && !url.href.includes('/signin'),
          { timeout: 10000 }
        );
      } catch {
        // URL didn't change - login may have failed or app doesn't redirect
        core.warning(`URL didn't change after login submit (still at ${page.url()})`);
      }
    }

    // Get the URL where user landed after login (dashboard, home, etc.)
    const postLoginUrl = page.url();

    // If still on login page, authentication likely failed
    if (postLoginUrl.includes('/login') || postLoginUrl.includes('/signin')) {
      core.warning(`Still on login page after submit - authentication may have failed`);
      // Check for error messages
      const errorSelectors = '[class*="error"], [class*="alert"], [role="alert"]';
      const errorEl = page.locator(errorSelectors).first();
      let errorText: string | null = null;
      try {
        if (await errorEl.isVisible({ timeout: 1000 })) {
          errorText = await errorEl.textContent();
          core.warning(`Login error message: ${errorText}`);
        }
      } catch {
        // No error element found
      }

      return {
        success: false,
        error: errorText || 'Login failed - still on login page after submit. Check credentials.',
      };
    }

    core.info(`Authentication successful, landed at: ${postLoginUrl}`);
    return { success: true, postLoginUrl };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Authentication failed: ${msg}`);
    return { success: false, error: msg };
  } finally {
    await page.close();
  }
}

/**
 * Crawl a single page using an existing browser context.
 * Internal function used by crawlSite.
 */
async function crawlPageWithContext(page: Page, url: string): Promise<PageContext> {
  core.info(`Crawling ${url} to discover page structure...`);

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

  // Extract buttons - include type in selector to avoid ambiguity
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
      .slice(0, 20)
      .map((btn, i) => {
        // Normalize whitespace - replace newlines/multiple spaces with single space
        const rawText = btn.textContent?.trim() || btn.getAttribute('value') || '';
        const text = rawText.replace(/\s+/g, ' ').substring(0, 50);
        const type = btn.getAttribute('type') || 'button';
        const tagName = btn.tagName.toLowerCase();

        let selector = '';
        if (btn.getAttribute('data-testid')) {
          selector = `[data-testid="${btn.getAttribute('data-testid')}"]`;
        } else if (btn.id) {
          selector = `#${btn.id}`;
        } else if (text && tagName === 'button') {
          // Include type in selector to avoid matching multiple buttons with same text
          // type="submit" buttons are form submissions, type="button" are regular buttons
          selector = `button[type="${type}"]:has-text("${text.substring(0, 30)}")`;
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
}

/**
 * Crawl a page and extract structured information about interactive elements.
 * This gives Claude real context about what's on the page.
 */
export async function crawlPage(url: string): Promise<PageContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    return await crawlPageWithContext(page, url);
  } finally {
    await browser.close();
  }
}

/**
 * Crawl multiple pages to build a site map.
 * @param baseUrl - The base URL to start crawling from
 * @param maxPages - Maximum number of pages to crawl
 * @param priorityPaths - URL paths to crawl first (e.g., ['/dashboard/multi-store'])
 * @param credentials - Optional credentials for authenticated crawling
 */
export async function crawlSite(
  baseUrl: string,
  maxPages: number = 5,
  priorityPaths: string[] = [],
  credentials?: CrawlCredentials
): Promise<CrawlResult> {
  const visited = new Set<string>();
  const pages: PageContext[] = [];
  let authResult: AuthResult | undefined;

  // Launch browser and create context (shared across all pages for session persistence)
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  try {
    // Authenticate if credentials provided
    if (credentials) {
      core.info('Authenticating before crawl...');
      authResult = await authenticate(context, baseUrl, credentials);

      if (!authResult.success) {
        core.warning(`Authentication failed: ${authResult.error}. Continuing with anonymous crawl.`);
      } else {
        core.info(`Authentication successful. Starting authenticated crawl.`);
      }
    }

    // Build initial queue: priority paths first, then base URL
    const toVisit: string[] = [];

    // If authenticated, start from post-login URL if available
    const startUrl = authResult?.postLoginUrl || baseUrl;

    // Add priority paths first (pages affected by the PR)
    for (const path of priorityPaths) {
      try {
        const fullUrl = new URL(path, baseUrl).href;
        if (!toVisit.includes(fullUrl)) {
          toVisit.push(fullUrl);
          core.info(`  Priority page: ${path}`);
        }
      } catch {
        // Invalid URL path, skip
      }
    }

    // Add start URL if not already in queue
    if (!toVisit.includes(startUrl)) {
      toVisit.push(startUrl);
    }

    // Also add base URL if different from start URL
    if (startUrl !== baseUrl && !toVisit.includes(baseUrl)) {
      toVisit.push(baseUrl);
    }

    while (toVisit.length > 0 && pages.length < maxPages) {
      const url = toVisit.shift()!;

      // Normalize URL
      const normalizedUrl = new URL(url, baseUrl).href;
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      try {
        // Use shared context page for authenticated crawling
        const page = await context.newPage();
        try {
          const pageContext = await crawlPageWithContext(page, normalizedUrl);
          pages.push(pageContext);

          // Add internal links to visit queue
          for (const link of pageContext.links) {
            if (link.href.startsWith('/') || link.href.startsWith(baseUrl)) {
              const fullUrl = new URL(link.href, baseUrl).href;
              if (!visited.has(fullUrl) && !toVisit.includes(fullUrl)) {
                toVisit.push(fullUrl);
              }
            }
          }
        } finally {
          await page.close();
        }
      } catch (error) {
        core.warning(`Failed to crawl ${normalizedUrl}: ${error}`);
      }
    }

    return { pages, authResult };
  } finally {
    await browser.close();
  }
}
