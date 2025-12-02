import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import { ScoutAIClient, ResultPayload } from './api/client';
import { extractDiffMetadata } from './diff/extractor';
import { executeFlows } from './executor/playwright';
import { postPRComment, calculateSummary, setOutputs } from './reporter/github';
import { crawlSite } from './crawler';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Convert local screenshot paths to base64 data URLs
 */
function convertScreenshotsToDataUrls(results: ResultPayload[]): ResultPayload[] {
  return results.map(result => ({
    ...result,
    screenshot_urls: result.screenshot_urls.map(screenshotPath => {
      try {
        if (fs.existsSync(screenshotPath)) {
          const imageData = fs.readFileSync(screenshotPath);
          const base64 = imageData.toString('base64');
          const ext = path.extname(screenshotPath).toLowerCase();
          const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
          return `data:${mimeType};base64,${base64}`;
        }
      } catch (error) {
        core.warning(`Failed to read screenshot ${screenshotPath}: ${error}`);
      }
      return screenshotPath; // Return original path if conversion fails
    }),
  }));
}

async function installPlaywright(): Promise<void> {
  core.info('Installing Playwright browsers...');
  await exec.exec('npx', ['playwright', 'install', 'chromium']);
}

/**
 * Detect what triggered this run based on GitHub context
 */
function detectTrigger(): string {
  const eventName = github.context.eventName;

  if (eventName === 'pull_request') {
    return 'pr';
  } else if (eventName === 'schedule') {
    return 'schedule';
  } else if (eventName === 'deployment_status') {
    return 'deployment';
  } else if (eventName === 'workflow_dispatch') {
    return 'manual';
  }

  return 'manual';
}

async function run(): Promise<void> {
  const startTime = Date.now();

  try {
    // Get inputs
    const apiKey = core.getInput('api-key', { required: true });
    const baseUrl = core.getInput('base-url', { required: true });
    const mode = core.getInput('mode') as 'fast' | 'deep' || 'fast';
    const apiEndpoint = core.getInput('api-endpoint') || 'https://scoutai-api.onrender.com';
    let projectId = core.getInput('project-id');

    // Auth inputs (optional - can also be configured via API)
    const authUsername = core.getInput('auth-username');
    const authPassword = core.getInput('auth-password');
    const authLoginUrl = core.getInput('auth-login-url') || '/login';

    // Environment and trigger inputs
    const environment = core.getInput('environment') || 'staging';
    const trigger = core.getInput('trigger') || detectTrigger();

    core.info(`ScoutAI QA - Mode: ${mode}`);
    core.info(`Environment: ${environment}, Trigger: ${trigger}`);
    core.info(`Base URL: ${baseUrl}`);
    core.info(`API Endpoint: ${apiEndpoint}`);

    // Initialize client
    const client = new ScoutAIClient(apiKey, apiEndpoint);

    // Get or create project
    const context = github.context;
    const repoFullName = `${context.repo.owner}/${context.repo.repo}`;

    if (!projectId) {
      core.info(`Looking up project for ${repoFullName}...`);
      let project = await client.getProjectByRepo(repoFullName);

      if (!project) {
        core.info(`Creating new project for ${repoFullName}...`);
        project = await client.createProject(
          context.repo.repo,
          repoFullName,
          baseUrl
        );
      }
      projectId = project.id;
    }

    core.info(`Project ID: ${projectId}`);

    // Extract diff metadata
    core.info('Extracting diff metadata...');
    const diffMetadata = await extractDiffMetadata();
    core.info(`Found ${diffMetadata.files.length} changed files`);

    if (diffMetadata.files.length > 0) {
      core.debug('Changed files:');
      for (const file of diffMetadata.files.slice(0, 10)) {
        core.debug(`  ${file.status}: ${file.path} (+${file.additions}/-${file.deletions})`);
      }
      if (diffMetadata.files.length > 10) {
        core.debug(`  ... and ${diffMetadata.files.length - 10} more`);
      }
    }

    // Install Playwright browsers (needed for crawling)
    await installPlaywright();

    // Crawl the site to get real page structure (up to 3 pages in fast mode, 5 in deep)
    const maxPages = mode === 'fast' ? 3 : 5;
    core.info(`Crawling site to discover page structure (max ${maxPages} pages)...`);
    let siteContext;
    try {
      const pages = await crawlSite(baseUrl, maxPages);
      siteContext = { pages };

      // Summarize what we found
      const totalLinks = pages.reduce((sum, p) => sum + p.links.length, 0);
      const totalForms = pages.reduce((sum, p) => sum + p.forms.length, 0);
      const totalInputs = pages.reduce((sum, p) => sum + p.forms.reduce((s, f) => s + f.inputs.length, 0), 0);
      const totalButtons = pages.reduce((sum, p) => sum + p.buttons.length, 0);
      core.info(`Crawled ${pages.length} pages. Found: ${totalLinks} links, ${totalForms} forms, ${totalInputs} inputs, ${totalButtons} buttons`);

      for (const page of pages) {
        core.info(`  - ${page.url}: ${page.forms.length} forms, ${page.forms.reduce((s, f) => s + f.inputs.length, 0)} inputs`);
      }
    } catch (error) {
      core.warning(`Failed to crawl site: ${error}. Proceeding without site context.`);
    }

    // Generate test plan
    core.info('Generating test plan with AI...');
    const planResponse = await client.generatePlan(
      projectId,
      diffMetadata,
      mode,
      baseUrl,
      siteContext,
      environment,
      trigger
    );

    const { run_id: runId, test_plan: testPlan } = planResponse;
    core.info(`Run ID: ${runId}`);
    core.info(`Risk Score: ${testPlan.risk_score}/10`);
    core.info(`Flows to execute: ${testPlan.flows.length}`);

    if (testPlan.flows.length === 0) {
      core.info('No flows to execute - test plan is empty');
      setOutputs(runId, 'passed', { passed: 0, failed: 0, skipped: 0, duration_ms: 0 });
      return;
    }

    // Log flow names
    for (const flow of testPlan.flows) {
      core.info(`  - ${flow.name} (priority: ${flow.priority})`);
    }

    // Mark run as started
    await client.startRun(runId);

    // Determine test account for authentication
    // Priority: 1) Action inputs, 2) API-configured account
    let testAccount = null;

    if (authUsername && authPassword) {
      // Use credentials from action inputs
      core.info(`Using auth credentials from action inputs`);
      testAccount = {
        id: 'input-auth',
        name: 'Action Input Auth',
        role: 'user',
        email: authUsername,
        password: authPassword,
        auth_type: 'form' as const,
        login_url: authLoginUrl,
        is_default: true,
        is_active: true,
      };
    } else {
      // Try to fetch from API
      core.info('Checking for test account in API...');
      testAccount = await client.getDefaultTestAccount(projectId);
      if (testAccount) {
        core.info(`Found test account: ${testAccount.name} (${testAccount.role})`);
      } else {
        core.info('No test account configured - running without authentication');
      }
    }

    // Create screenshots directory
    const screenshotDir = './scoutai-screenshots';
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // Execute flows with time limit
    const maxDuration = mode === 'fast' ? 55000 : 9 * 60 * 1000; // 55s for fast, 9min for deep
    core.info(`Executing flows (max ${maxDuration / 1000}s)...`);

    const results = await executeFlows(testPlan.flows, baseUrl, maxDuration, testAccount);

    // Calculate summary
    const summary = calculateSummary(results);
    const overallStatus = summary.failed > 0 ? 'failed' : 'passed';

    core.info('');
    core.info('=== Results ===');
    core.info(`Passed: ${summary.passed}`);
    core.info(`Failed: ${summary.failed}`);
    core.info(`Duration: ${(summary.duration_ms / 1000).toFixed(1)}s`);

    // Convert screenshot paths to base64 data URLs and upload results
    core.info('Processing screenshots and uploading results...');
    const resultsWithScreenshots = convertScreenshotsToDataUrls(results);
    await client.uploadResults(runId, resultsWithScreenshots);

    // Complete run
    await client.completeRun(runId, overallStatus, {
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
    });

    // Post PR comment
    await postPRComment(testPlan, results, runId);

    // Set outputs
    setOutputs(runId, overallStatus, summary);

    // Set final status
    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    if (overallStatus === 'failed') {
      core.setFailed(`ScoutAI QA: ${summary.failed} flow(s) failed (${totalDuration}s)`);
    } else {
      core.info(`ScoutAI QA: All ${summary.passed} flows passed (${totalDuration}s)`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`ScoutAI QA failed: ${message}`);
  }
}

run();
