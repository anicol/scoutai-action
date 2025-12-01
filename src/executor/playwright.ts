import * as core from '@actions/core';
import { chromium, Browser, Page } from 'playwright';
import { FlowPlan, PlaywrightStep, ResultPayload, StepResult } from '../api/client';

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private baseUrl: string;
  private screenshotDir: string;

  constructor(baseUrl: string, screenshotDir: string = './screenshots') {
    this.baseUrl = baseUrl;
    this.screenshotDir = screenshotDir;
  }

  async initialize(): Promise<void> {
    core.info('Launching browser...');
    this.browser = await chromium.launch({
      headless: true,
    });
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async executeFlow(flow: FlowPlan): Promise<ResultPayload> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    const screenshotUrls: string[] = [];
    let flowStatus: 'passed' | 'failed' = 'passed';
    let errorMessage: string | undefined;

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    core.info(`Executing flow: ${flow.name}`);

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

          // Take screenshot on failure
          const screenshotPath = `${this.screenshotDir}/${flow.id}-failure-${i}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          screenshotUrls.push(screenshotPath);

          break; // Stop flow on first failure
        }
      }

      // Take final screenshot if passed
      if (flowStatus === 'passed') {
        const screenshotPath = `${this.screenshotDir}/${flow.id}-final.png`;
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

    // Standard CSS/Playwright selector
    return page.locator(selector);
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
  maxDurationMs: number = 60000
): Promise<ResultPayload[]> {
  const executor = new PlaywrightExecutor(baseUrl);
  const results: ResultPayload[] = [];
  const startTime = Date.now();

  try {
    await executor.initialize();

    // Sort flows by priority (higher first)
    const sortedFlows = [...flows].sort((a, b) => b.priority - a.priority);

    for (const flow of sortedFlows) {
      // Check if we're running out of time
      const elapsed = Date.now() - startTime;
      if (elapsed > maxDurationMs) {
        core.warning(`Time limit reached, skipping remaining flows`);
        break;
      }

      const result = await executor.executeFlow(flow);
      results.push(result);
    }
  } finally {
    await executor.cleanup();
  }

  return results;
}
