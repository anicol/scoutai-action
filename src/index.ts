import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import { ScoutAIClient, ResultPayload, DiffFile } from './api/client';
import { extractDiffMetadata, extractLikelyUrls } from './diff/extractor';
import { executeFlows } from './executor/playwright';
import { postPRComment, postSkippedPRComment, calculateSummary, setOutputs } from './reporter/github';
import { createIssuesForFailures } from './reporter/issues';
import { crawlSite, CrawlCredentials } from './crawler';
import * as fs from 'fs';
import * as path from 'path';

/**
 * File categories for determining test relevance
 */
interface FileCategories {
  ui: DiffFile[];
  api: DiffFile[];
  logic: DiffFile[];
  config: DiffFile[];
  infra: DiffFile[];
  test: DiffFile[];
  docs: DiffFile[];
}

/**
 * Categorize changed files to determine what type of testing is needed
 */
function categorizeChangedFiles(files: DiffFile[]): FileCategories {
  const categories: FileCategories = {
    ui: [],
    api: [],
    logic: [],
    config: [],
    infra: [],
    test: [],
    docs: [],
  };

  const uiExtensions = ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.css', '.scss', '.sass', '.less'];
  const apiPatterns = ['routes', 'controllers', 'handlers', 'views', 'api/', 'endpoints'];
  const infraPatterns = [
    '.github/', 'dockerfile', 'docker-compose', 'terraform', '.gitlab-ci',
    'jenkinsfile', 'circleci', '.travis', 'azure-pipelines', 'bitbucket-pipelines',
    'render.yaml', 'vercel.json', 'netlify.toml', 'railway.json', 'fly.toml'
  ];
  const testPatterns = ['test', 'spec', '__tests__', 'e2e', 'cypress', 'playwright'];

  for (const file of files) {
    const pathLower = file.path.toLowerCase();

    // Infrastructure files (highest priority - check first)
    if (infraPatterns.some(p => pathLower.includes(p))) {
      categories.infra.push(file);
    }
    // Documentation
    else if (pathLower.endsWith('.md') || pathLower.startsWith('docs/') || pathLower.includes('/docs/')) {
      categories.docs.push(file);
    }
    // Test files
    else if (testPatterns.some(p => pathLower.includes(p))) {
      categories.test.push(file);
    }
    // UI files
    else if (uiExtensions.some(ext => pathLower.endsWith(ext))) {
      categories.ui.push(file);
    }
    // API files
    else if (apiPatterns.some(p => pathLower.includes(p))) {
      categories.api.push(file);
    }
    // Config files (non-infra)
    else if (['.json', '.yml', '.yaml', '.toml', '.env'].some(ext => pathLower.endsWith(ext))) {
      categories.config.push(file);
    }
    // Default to logic
    else {
      categories.logic.push(file);
    }
  }

  return categories;
}

/**
 * Check if the change is infrastructure/docs only (no user-facing changes)
 */
function isInfraOnlyChange(categories: FileCategories): boolean {
  const hasInfra = categories.infra.length > 0;
  const hasDocs = categories.docs.length > 0;
  const hasTest = categories.test.length > 0;

  const userFacingCount =
    categories.ui.length +
    categories.api.length +
    categories.logic.length +
    categories.config.length;

  // Skip tests if ONLY infra/docs/test files changed
  return userFacingCount === 0 && (hasInfra || hasDocs || hasTest);
}

/**
 * Get a human-readable description of what changed
 */
function getChangeDescription(categories: FileCategories): string {
  const parts: string[] = [];

  if (categories.infra.length > 0) {
    parts.push(`${categories.infra.length} infrastructure file(s)`);
  }
  if (categories.docs.length > 0) {
    parts.push(`${categories.docs.length} documentation file(s)`);
  }
  if (categories.test.length > 0) {
    parts.push(`${categories.test.length} test file(s)`);
  }

  return parts.join(', ');
}

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

/**
 * Detect preview URL from deployment events or PR comments.
 * Supports: GitHub deployment_status, Vercel bot comments, Netlify.
 */
async function detectPreviewUrl(): Promise<string | null> {
  const context = github.context;
  const token = process.env.GITHUB_TOKEN;

  // Check for deployment_status event with environment URL
  if (context.eventName === 'deployment_status') {
    const payload = context.payload as {
      deployment_status?: {
        environment_url?: string;
        state?: string;
      };
    };

    // Only use successful deployments
    if (payload.deployment_status?.state === 'success' &&
        payload.deployment_status?.environment_url) {
      core.info(`Detected preview URL from deployment_status: ${payload.deployment_status.environment_url}`);
      return payload.deployment_status.environment_url;
    }
  }

  // For PR events, check PR comments for Vercel/Netlify bot URLs
  if (context.eventName === 'pull_request' && token) {
    const prNumber = context.payload.pull_request?.number;
    if (!prNumber) return null;

    try {
      const octokit = github.getOctokit(token);
      const { data: comments } = await octokit.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        per_page: 50,
      });

      // Check for Vercel bot comment
      const vercelComment = comments.find(c =>
        c.user?.login === 'vercel[bot]' &&
        c.body?.includes('Preview:')
      );
      if (vercelComment?.body) {
        const match = vercelComment.body.match(/https:\/\/[^\s\)]+\.vercel\.app/);
        if (match) {
          core.info(`Detected Vercel preview URL from PR comment: ${match[0]}`);
          return match[0];
        }
      }

      // Check for Netlify bot comment
      const netlifyComment = comments.find(c =>
        c.user?.login === 'netlify[bot]' &&
        c.body?.includes('Deploy Preview')
      );
      if (netlifyComment?.body) {
        const match = netlifyComment.body.match(/https:\/\/[^\s\)]+\.netlify\.app/);
        if (match) {
          core.info(`Detected Netlify preview URL from PR comment: ${match[0]}`);
          return match[0];
        }
      }

      // Check for GitHub deployments on the commit
      const commitSha = context.payload.pull_request?.head?.sha;
      if (commitSha) {
        const { data: deployments } = await octokit.rest.repos.listDeployments({
          owner: context.repo.owner,
          repo: context.repo.repo,
          sha: commitSha,
          per_page: 5,
        });

        for (const deployment of deployments) {
          const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
            owner: context.repo.owner,
            repo: context.repo.repo,
            deployment_id: deployment.id,
            per_page: 1,
          });

          const latestStatus = statuses[0];
          if (latestStatus?.state === 'success' && latestStatus?.environment_url) {
            core.info(`Detected preview URL from GitHub deployment: ${latestStatus.environment_url}`);
            return latestStatus.environment_url;
          }
        }
      }
    } catch (error) {
      core.debug(`Failed to detect preview URL: ${error}`);
    }
  }

  return null;
}

async function run(): Promise<void> {
  const startTime = Date.now();

  try {
    // Get inputs
    const apiKey = core.getInput('api-key', { required: true });
    let baseUrl = core.getInput('base-url');  // Now optional - can come from project config
    const mode = core.getInput('mode') as 'fast' | 'deep' || 'fast';
    const apiEndpoint = core.getInput('api-endpoint') || 'https://scoutai-api.onrender.com';
    let projectId = core.getInput('project-id');

    // Auth inputs (optional - can also be configured via API)
    const authUsername = core.getInput('auth-username');
    const authPassword = core.getInput('auth-password');
    const authLoginUrl = core.getInput('auth-login-url') || '/login';
    const authEmailSelector = core.getInput('auth-email-selector');
    const authPasswordSelector = core.getInput('auth-password-selector');
    const authSubmitSelector = core.getInput('auth-submit-selector');
    const authSuccessIndicator = core.getInput('auth-success-indicator');

    // Environment and trigger inputs
    let environment = core.getInput('environment') || 'staging';
    const trigger = core.getInput('trigger') || detectTrigger();
    const createIssues = core.getInput('create-issues') === 'true';
    const skipInfraOnly = core.getInput('skip-infra-only') !== 'false'; // Default true
    const viewportsInput = core.getInput('viewports') || 'desktop';
    const viewports = viewportsInput.split(',').map(v => v.trim()).filter(v => ['desktop', 'mobile'].includes(v));

    core.info(`ScoutAI QA - Mode: ${mode}`);
    core.info(`Environment: ${environment}, Trigger: ${trigger}`);
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
        if (!baseUrl) {
          throw new Error('base-url is required when creating a new project. Configure it in the action or create the project in ScoutAI first.');
        }
        core.info(`Creating new project for ${repoFullName}...`);
        project = await client.createProject(
          context.repo.repo,
          repoFullName,
          baseUrl
        );
      }
      projectId = project.id;

      // Use project's base_url if not provided in action inputs
      if (!baseUrl && project.base_url) {
        baseUrl = project.base_url;
        core.info(`Using base URL from project config: ${baseUrl}`);
      }
    }

    // Try to auto-detect preview URL if no base-url provided
    if (!baseUrl) {
      const previewUrl = await detectPreviewUrl();
      if (previewUrl) {
        baseUrl = previewUrl;
        environment = 'preview';
        core.info(`Auto-detected preview URL: ${baseUrl}`);
      }
    }

    if (!baseUrl) {
      throw new Error('base-url is required. Either provide it in the action inputs or configure it in your ScoutAI project settings.');
    }

    core.info(`Project ID: ${projectId}`);
    core.info(`Base URL: ${baseUrl}`);

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

    // Categorize files and check for infra-only changes
    const categories = categorizeChangedFiles(diffMetadata.files);
    const infraOnly = isInfraOnlyChange(categories);

    core.info(`File categories: UI=${categories.ui.length}, API=${categories.api.length}, Logic=${categories.logic.length}, ` +
              `Config=${categories.config.length}, Infra=${categories.infra.length}, Test=${categories.test.length}, Docs=${categories.docs.length}`);

    // Skip tests for infrastructure-only changes if enabled
    if (skipInfraOnly && infraOnly && diffMetadata.files.length > 0) {
      const changeDesc = getChangeDescription(categories);
      core.info(`Infrastructure-only change detected (${changeDesc}) - skipping user-facing tests`);

      // Post a minimal PR comment explaining the skip
      await postSkippedPRComment(changeDesc, diffMetadata.files);

      // Set outputs for skipped run
      setOutputs('skipped', 'passed', { passed: 0, failed: 0, skipped: 0, duration_ms: 0 });
      core.info('ScoutAI QA: Skipped - no user-facing changes detected');
      return;
    }

    // Install Playwright browsers (needed for crawling)
    await installPlaywright();

    // Extract likely URLs from changed file paths to prioritize crawling affected pages
    const priorityPaths = extractLikelyUrls(diffMetadata.files);
    if (priorityPaths.length > 0) {
      core.info(`Extracted ${priorityPaths.length} likely URLs from changed files:`);
      for (const path of priorityPaths) {
        core.info(`  - ${path}`);
      }
    }

    // Crawl the site to get real page structure (up to 3 pages in fast mode, 5 in deep)
    // Priority paths (pages affected by PR) are crawled first
    const maxPages = mode === 'fast' ? 3 : 5;
    core.info(`Crawling site to discover page structure (max ${maxPages} pages)...`);

    // Build crawl credentials if auth inputs are provided
    let crawlCredentials: CrawlCredentials | undefined;
    if (authUsername && authPassword) {
      crawlCredentials = {
        email: authUsername,
        password: authPassword,
        loginUrl: authLoginUrl,
        emailSelector: authEmailSelector || undefined,
        passwordSelector: authPasswordSelector || undefined,
        submitSelector: authSubmitSelector || undefined,
        successIndicator: authSuccessIndicator || undefined,
      };
      core.info('Crawling with authentication enabled');
    }

    let siteContext;
    let crawlAuthResult;
    try {
      const crawlResult = await crawlSite(baseUrl, maxPages, priorityPaths, crawlCredentials);
      siteContext = { pages: crawlResult.pages };
      crawlAuthResult = crawlResult.authResult;

      if (crawlAuthResult) {
        if (crawlAuthResult.success) {
          core.info(`Authenticated crawl successful - landed at: ${crawlAuthResult.postLoginUrl}`);
        } else {
          core.warning(`Authenticated crawl failed: ${crawlAuthResult.error}`);
        }
      }

      // Summarize what we found
      const pages = crawlResult.pages;
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

    const results = await executeFlows(testPlan.flows, baseUrl, maxDuration, testAccount, viewports);

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

    // Create GitHub Issues for failures if enabled
    if (createIssues && summary.failed > 0) {
      core.info('Creating GitHub Issues for failed flows...');
      const issueUrls = await createIssuesForFailures(
        results,
        runId,
        context.payload.pull_request?.number,
        diffMetadata.commit_sha,
        diffMetadata.branch
      );
      if (issueUrls.length > 0) {
        core.info(`Created ${issueUrls.length} issue(s) for test failures`);
      }
    }

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
