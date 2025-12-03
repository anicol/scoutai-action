import * as core from '@actions/core';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { FlowPlan, PlaywrightStep, ResultPayload, StepResult, TestAccount } from '../api/client';

// Supported viewports for testing
const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 375, height: 667 },  // iPhone SE
};

// Mobile user agent for more realistic mobile testing
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private baseUrl: string;
  private screenshotDir: string;
  private testAccount: TestAccount | null = null;
  private storageState: string | null = null;

  constructor(baseUrl: string, screenshotDir: string = './screenshots') {
    this.baseUrl = baseUrl;
    this.screenshotDir = screenshotDir;
  }

  setTestAccount(account: TestAccount | null) {
    this.testAccount = account;
  }

  async initialize(): Promise<void> {
    core.info('Launching browser...');
    this.browser = await chromium.launch({
      headless: true,
    });

    // If we have a test account, authenticate and save the session
    if (this.testAccount) {
      await this.authenticate();
    }
  }

  /**
   * Authenticate using the configured test account.
   * Saves session state to reuse across flows.
   */
  private async authenticate(): Promise<void> {
    if (!this.browser || !this.testAccount) return;

    const account = this.testAccount;
    core.info(`Authenticating as ${account.name} (${account.role})...`);

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    try {
      // Navigate to login page
      const loginUrl = account.login_url.startsWith('http')
        ? account.login_url
        : `${this.baseUrl}${account.login_url}`;
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 15000 });

      // Fill email - use configured selector or try common patterns
      const emailSelector = account.email_selector ||
        'input[type="email"], input[name="email"], input[id="email"], [placeholder*="email" i]';
      await page.locator(emailSelector).first().fill(account.email, { timeout: 5000 });

      // Fill password
      const passwordSelector = account.password_selector ||
        'input[type="password"], input[name="password"], input[id="password"]';
      await page.locator(passwordSelector).first().fill(account.password, { timeout: 5000 });

      // Submit form
      const submitSelector = account.submit_selector ||
        'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")';
      await page.locator(submitSelector).first().click({ timeout: 5000 });

      // Wait for navigation/login to complete
      await page.waitForLoadState('networkidle', { timeout: 10000 });

      // Verify login succeeded if indicator is configured
      if (account.success_indicator) {
        if (account.success_indicator.startsWith('/')) {
          // URL pattern
          await page.waitForURL(`**${account.success_indicator}*`, { timeout: 10000 });
        } else {
          // Selector
          await page.locator(account.success_indicator).waitFor({ state: 'visible', timeout: 10000 });
        }
      }

      // Save storage state (cookies, localStorage) for reuse
      this.storageState = './scoutai-auth-state.json';
      await context.storageState({ path: this.storageState });
      core.info(`  ✓ Authenticated successfully as ${account.name}`);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      core.warning(`  ✗ Authentication failed: ${msg}`);
      core.warning('  Continuing without authentication...');
      this.storageState = null;
    } finally {
      await context.close();
    }
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async executeFlow(flow: FlowPlan, viewport: string = 'desktop'): Promise<ResultPayload> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    const screenshotUrls: string[] = [];
    let flowStatus: 'passed' | 'failed' = 'passed';
    let errorMessage: string | undefined;

    // Get viewport settings
    const vp = VIEWPORTS[viewport as keyof typeof VIEWPORTS] || VIEWPORTS.desktop;

    // Use saved auth state if available
    const contextOptions: any = {
      viewport: vp,
      ...(this.storageState ? { storageState: this.storageState } : {}),
    };

    // Add mobile-specific settings
    if (viewport === 'mobile') {
      contextOptions.userAgent = MOBILE_USER_AGENT;
      contextOptions.isMobile = true;
      contextOptions.hasTouch = true;
    }

    const context = await this.browser.newContext(contextOptions);
    const page = await context.newPage();

    const viewportLabel = viewport !== 'desktop' ? ` [${viewport}]` : '';
    core.info(`Executing flow: ${flow.name}${viewportLabel}${this.storageState ? ' (authenticated)' : ''}`);

    try {
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        const stepStart = Date.now();

        try {
          await this.executeStep(page, step);
          stepResults.push({
            description: step.description,
            status: 'passed',
            duration_ms: Date.now() - stepStart,
          });
          core.info(`  ✓ ${step.description}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          stepResults.push({
            description: step.description,
            status: 'failed',
            duration_ms: Date.now() - stepStart,
            error: errorMsg,
          });
          core.error(`  ✗ ${step.description}: ${errorMsg}`);
          flowStatus = 'failed';
          errorMessage = `Step failed: ${step.description} - ${errorMsg}`;

          // Take screenshot on failure (include viewport in filename)
          const screenshotPath = `${this.screenshotDir}/${flow.id}-${viewport}-failure-${i}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          screenshotUrls.push(screenshotPath);

          break; // Stop flow on first failure
        }
      }

      // Take final screenshot if passed
      if (flowStatus === 'passed') {
        const screenshotPath = `${this.screenshotDir}/${flow.id}-${viewport}-final.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshotUrls.push(screenshotPath);
      }
    } finally {
      await context.close();
    }

    return {
      flow_name: flow.name,
      status: flowStatus,
      duration_ms: Date.now() - startTime,
      error_message: errorMessage,
      steps: stepResults,
      screenshot_urls: screenshotUrls,
      viewport: viewport,
    };
  }

  private async executeStep(page: Page, step: PlaywrightStep): Promise<void> {
    const timeout = 10000; // 10 second timeout per step

    switch (step.action) {
      case 'navigate':
        if (!step.value) throw new Error('Navigate requires a URL value');
        const url = step.value.toString().startsWith('http')
          ? step.value.toString()
          : `${this.baseUrl}${step.value}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout });
        break;

      case 'click':
        if (!step.selector) throw new Error('Click requires a selector');
        await this.smartLocator(page, step.selector).click({ timeout });
        break;

      case 'fill':
        if (!step.selector) throw new Error('Fill requires a selector');
        if (step.value === undefined) throw new Error('Fill requires a value');
        await this.smartLocator(page, step.selector).fill(step.value.toString(), { timeout });
        break;

      case 'assert':
        if (!step.selector) throw new Error('Assert requires a selector');
        await this.smartLocator(page, step.selector).waitFor({ state: 'visible', timeout });
        break;

      case 'wait':
        const waitTime = typeof step.value === 'number' ? step.value : parseInt(step.value?.toString() || '1000', 10);
        await page.waitForTimeout(waitTime);
        break;

      case 'screenshot':
        // Screenshot is handled by the executor
        break;

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  /**
   * Smart locator that handles multiple selector types:
   * - If selector contains comma with mixed types (CSS + text), try each separately
   * - text="..." -> use getByText
   * - CSS selectors -> use locator()
   * - Automatically tries whitespace variants for emoji-containing selectors
   */
  private smartLocator(page: Page, selector: string) {
    // If it's a simple text selector like text="Login"
    if (selector.startsWith('text=')) {
      const text = selector.slice(5).replace(/^["']|["']$/g, '');
      return page.getByText(text);
    }

    // If it contains comma-separated alternatives with mixed types
    if (selector.includes(',')) {
      const parts = selector.split(',').map(s => s.trim());

      // Check if any part is a text selector
      const hasTextSelector = parts.some(p => p.startsWith('text='));

      if (hasTextSelector) {
        // Build a proper locator chain using .or()
        let locator = this.singleLocator(page, parts[0]);
        for (let i = 1; i < parts.length; i++) {
          locator = locator.or(this.singleLocator(page, parts[i]));
        }
        return locator;
      }
    }

    // Get selector variants to handle whitespace issues with emojis
    const variants = this.getSelectorVariants(selector);

    if (variants.length > 1) {
      // Build locator chain with .or() to try all variants
      let locator = page.locator(variants[0]);
      for (let i = 1; i < variants.length; i++) {
        locator = locator.or(page.locator(variants[i]));
      }
      return locator;
    }

    // Standard CSS/Playwright selector
    return page.locator(selector);
  }

  /**
   * Generate alternative selectors to handle whitespace issues.
   * Returns array of selectors to try in order.
   */
  private getSelectorVariants(selector: string): string[] {
    const variants = [selector];

    // Match :has-text("...") patterns
    const hasTextMatch = selector.match(/:has-text\("([^"]+)"\)/);
    if (hasTextMatch) {
      const textContent = hasTextMatch[1];
      // Check if text has emoji that might have whitespace issues
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]/u.test(textContent);
      if (hasEmoji) {
        // Try adding space after emoji: "🍔Restaurant" -> "🍔 Restaurant"
        const withSpace = textContent.replace(/([\u{1F300}-\u{1F9FF}])(\w)/gu, '$1 $2');
        if (withSpace !== textContent) {
          variants.push(selector.replace(`:has-text("${textContent}")`, `:has-text("${withSpace}")`));
        }
        // Try removing space after emoji: "🍔 Restaurant" -> "🍔Restaurant"
        const withoutSpace = textContent.replace(/([\u{1F300}-\u{1F9FF}])\s+/gu, '$1');
        if (withoutSpace !== textContent) {
          variants.push(selector.replace(`:has-text("${textContent}")`, `:has-text("${withoutSpace}")`));
        }
      }
    }

    return variants;
  }

  private singleLocator(page: Page, selector: string) {
    selector = selector.trim();
    if (selector.startsWith('text=')) {
      const text = selector.slice(5).replace(/^["']|["']$/g, '');
      return page.getByText(text);
    }
    return page.locator(selector);
  }
}

export async function executeFlows(
  flows: FlowPlan[],
  baseUrl: string,
  maxDurationMs: number = 60000,
  testAccount: TestAccount | null = null,
  viewports: string[] = ['desktop']
): Promise<ResultPayload[]> {
  const executor = new PlaywrightExecutor(baseUrl);
  executor.setTestAccount(testAccount);

  const results: ResultPayload[] = [];
  const startTime = Date.now();

  try {
    await executor.initialize();

    // Sort flows by priority (higher first)
    const sortedFlows = [...flows].sort((a, b) => b.priority - a.priority);

    // Execute each flow for each viewport
    for (const viewport of viewports) {
      const vp = VIEWPORTS[viewport as keyof typeof VIEWPORTS] || VIEWPORTS.desktop;
      core.info(`Testing with viewport: ${viewport} (${vp.width}x${vp.height})`);

      for (const flow of sortedFlows) {
        // Check if we're running out of time
        const elapsed = Date.now() - startTime;
        if (elapsed > maxDurationMs) {
          core.warning(`Time limit reached, skipping remaining flows`);
          break;
        }

        const result = await executor.executeFlow(flow, viewport);
        results.push(result);
      }

      // Check time limit after each viewport
      const elapsed = Date.now() - startTime;
      if (elapsed > maxDurationMs) {
        break;
      }
    }
  } finally {
    await executor.cleanup();
  }

  return results;
}
