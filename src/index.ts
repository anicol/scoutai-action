import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import { ScoutAIClient, ResultPayload, DiffFile, TestResult, GeneratedTest } from './api/client';
import { extractDiffMetadata, extractLikelyUrls } from './diff/extractor';
import { executeFlows } from './executor/playwright';
import { postPRComment, postSkippedPRComment, calculateSummary, setOutputs } from './reporter/github';
import { createIssuesForFailures } from './reporter/issues';
import { crawlSite, CrawlCredentials } from './crawler';
import { collectCodebaseContext } from './context/collector';
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

/**
 * Write generated tests to temporary directory
 */
function writeGeneratedTests(tests: GeneratedTest[]): string {
  const testDir = '.scout-tests';

  // Clean up existing directory
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  for (const test of tests) {
    // Determine file extension based on framework
    let ext = '.test.ts';
    if (test.test_framework === 'pytest') ext = '_test.py';
    else if (test.test_framework === 'go-test') ext = '_test.go';
    else if (test.test_framework === 'rspec') ext = '_spec.rb';
    else if (test.test_framework === 'vitest') ext = '.test.ts';
    else if (test.test_framework === 'jest') ext = '.test.ts';

    const fileName = test.name.replace(/[^a-zA-Z0-9_-]/g, '_') + ext;
    const filePath = path.join(testDir, fileName);

    fs.writeFileSync(filePath, test.test_code);
    core.info(`  Written: ${filePath}`);
  }

  return testDir;
}

/**
 * Execute generated tests using the project's test framework
 */
async function executeGeneratedTests(
  tests: GeneratedTest[],
  testDir: string,
  testFramework: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Determine test command based on framework
  let testCommand: string[];

  switch (testFramework) {
    case 'jest':
      testCommand = ['npx', 'jest', '--testPathPattern', testDir, '--json', '--outputFile', '.scout-results.json'];
      break;
    case 'vitest':
      testCommand = ['npx', 'vitest', 'run', testDir, '--reporter', 'json', '--outputFile', '.scout-results.json'];
      break;
    case 'pytest':
      testCommand = ['python', '-m', 'pytest', testDir, '--json-report', '--json-report-file=.scout-results.json'];
      break;
    case 'go-test':
      testCommand = ['go', 'test', '-v', '-json', `./${testDir}/...`];
      break;
    default:
      // Try to auto-detect based on package.json
      if (fs.existsSync('package.json')) {
        testCommand = ['npm', 'test', '--', testDir];
      } else if (fs.existsSync('pytest.ini') || fs.existsSync('pyproject.toml')) {
        testCommand = ['python', '-m', 'pytest', testDir, '-v'];
      } else {
        core.warning(`Unknown test framework: ${testFramework}, skipping execution`);
        return results;
      }
  }

  core.info(`Running tests with: ${testCommand.join(' ')}`);

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    exitCode = await exec.exec(testCommand[0], testCommand.slice(1), {
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        },
      },
      ignoreReturnCode: true,
    });
  } catch (error) {
    stderr += String(error);
    exitCode = 1;
  }

  const duration = Date.now() - startTime;

  // Try to parse structured results
  if (fs.existsSync('.scout-results.json')) {
    try {
      const jsonResults = JSON.parse(fs.readFileSync('.scout-results.json', 'utf-8'));

      // Parse Jest/Vitest format
      if (jsonResults.testResults) {
        for (const testResult of jsonResults.testResults) {
          for (const assertion of testResult.assertionResults || []) {
            const test = tests.find(t => testResult.name?.includes(t.name));
            results.push({
              test_id: test?.id || 'unknown',
              status: assertion.status === 'passed' ? 'passed' : 'failed',
              duration_ms: assertion.duration || 0,
              error_message: assertion.failureMessages?.join('\n'),
              stdout: stdout.slice(0, 10000),
              stderr: stderr.slice(0, 10000),
            });
          }
        }
      }
      // Parse pytest format
      else if (jsonResults.tests) {
        for (const testItem of jsonResults.tests) {
          const test = tests.find(t => testItem.nodeid?.includes(t.name));
          results.push({
            test_id: test?.id || 'unknown',
            status: testItem.outcome === 'passed' ? 'passed' : 'failed',
            duration_ms: (testItem.duration || 0) * 1000,
            error_message: testItem.longrepr,
            stdout: stdout.slice(0, 10000),
            stderr: stderr.slice(0, 10000),
          });
        }
      }

      // Clean up results file
      fs.unlinkSync('.scout-results.json');
    } catch (error) {
      core.debug(`Failed to parse test results JSON: ${error}`);
    }
  }

  // If no structured results, create one result per test based on exit code
  if (results.length === 0) {
    for (const test of tests) {
      results.push({
        test_id: test.id,
        status: exitCode === 0 ? 'passed' : 'failed',
        duration_ms: Math.floor(duration / tests.length),
        error_message: exitCode !== 0 ? `Test failed with exit code ${exitCode}` : undefined,
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 10000),
      });
    }
  }

  return results;
}

/**
 * Run Scout Test mode - AI-generated unit/API tests
 */
async function runScoutTestMode(
  client: ScoutAIClient,
  projectId: string,
  typePatterns: string[],
  schemaPatterns: string[]
): Promise<void> {
  const context = github.context;
  const prNumber = context.payload.pull_request?.number;
  const prTitle = context.payload.pull_request?.title;

  // Get git SHAs
  const baseSha = context.payload.pull_request?.base?.sha ||
    (await exec.getExecOutput('git', ['rev-parse', 'HEAD~1'])).stdout.trim();
  const headSha = context.payload.pull_request?.head?.sha ||
    (await exec.getExecOutput('git', ['rev-parse', 'HEAD'])).stdout.trim();

  core.info(`Analyzing changes: ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`);

  // Step 1: Collect codebase context
  core.info('Step 1: Collecting codebase context...');
  const codebaseContext = await collectCodebaseContext(
    typePatterns,
    schemaPatterns,
    baseSha,
    headSha
  );

  if (codebaseContext.diff.files.length === 0) {
    core.info('No changed files detected, skipping Scout Test');
    setOutputs('skipped', 'passed', { passed: 0, failed: 0, skipped: 0, duration_ms: 0 });
    return;
  }

  // Step 2: Upload context and start analysis
  core.info('Step 2: Uploading context to Scout API...');
  const analyzeResponse = await client.analyzeForScoutTest(
    projectId,
    codebaseContext,
    prNumber,
    prTitle
  );

  core.info(`Scout Test run ID: ${analyzeResponse.run_id}`);
  core.info(`Risk score: ${analyzeResponse.risk_score}/10`);
  core.info(`Coverage gaps: ${analyzeResponse.coverage_gaps.length}`);

  // Step 3: Wait for test generation
  core.info('Step 3: Waiting for test generation...');
  const run = await client.waitForScoutTestReady(analyzeResponse.run_id, 180000); // 3 min timeout

  if (run.tests.length === 0) {
    core.info('No tests generated - coverage is sufficient');
    setOutputs(analyzeResponse.run_id, 'passed', { passed: 0, failed: 0, skipped: 0, duration_ms: 0 });
    return;
  }

  core.info(`Generated ${run.tests.length} tests`);

  // Step 4: Write tests to temporary directory
  core.info('Step 4: Writing generated tests...');
  const testDir = writeGeneratedTests(run.tests);

  // Step 5: Execute tests
  core.info('Step 5: Executing generated tests...');
  const testFramework = codebaseContext.project.test_framework || 'jest';
  const results = await executeGeneratedTests(run.tests, testDir, testFramework);

  // Step 6: Report results back to Scout
  core.info('Step 6: Reporting results to Scout API...');
  await client.reportScoutTestResults(analyzeResponse.run_id, results);

  // Calculate summary
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

  core.info('');
  core.info('=== Scout Test Results ===');
  core.info(`Passed: ${passed}`);
  core.info(`Failed: ${failed}`);
  core.info(`Risk Score: ${run.risk_score}/10`);
  if (run.merge_recommendation) {
    core.info(`Recommendation: ${run.merge_recommendation.toUpperCase()}`);
    if (run.recommendation_reason) {
      core.info(`Reason: ${run.recommendation_reason}`);
    }
  }

  // Set outputs
  setOutputs(analyzeResponse.run_id, failed > 0 ? 'failed' : 'passed', {
    passed,
    failed,
    skipped: 0,
    duration_ms: totalDuration,
  });

  // Clean up
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }

  // Set final status
  if (failed > 0) {
    core.setFailed(`Scout Test: ${failed} test(s) failed`);
  } else {
    core.info(`Scout Test: All ${passed} tests passed`);
  }
}

async function run(): Promise<void> {
  const startTime = Date.now();

  try {
    // Get inputs
    const apiKey = core.getInput('api-key', { required: true });
    let baseUrl = core.getInput('base-url');  // Now optional - can come from project config
    const mode = core.getInput('mode') as 'fast' | 'deep' | 'scout-test' || 'fast';
    const apiEndpoint = core.getInput('api-endpoint') || 'https://scoutai-api.onrender.com';
    let projectId = core.getInput('project-id');

    // Scout Test specific inputs
    const includeTypes = core.getInput('include-types') || '**/*.d.ts,**/types.ts,**/types/**/*.ts';
    const includeSchemas = core.getInput('include-schemas') || 'openapi.json,openapi.yaml,schema.graphql,prisma/schema.prisma';

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

    core.info(`Project ID: ${projectId}`);

    // Scout Test mode - AI-generated unit/API tests (no base URL needed)
    if (mode === 'scout-test') {
      core.info('Running in Scout Test mode (AI-generated unit/API tests)');
      const typePatterns = includeTypes.split(',').map(p => p.trim());
      const schemaPatterns = includeSchemas.split(',').map(p => p.trim());
      await runScoutTestMode(client, projectId, typePatterns, schemaPatterns);
      return;
    }

    // E2E modes (fast/deep) require a base URL
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

    // Determine test account for authentication (used for both crawling and execution)
    // Priority: 1) Action inputs, 2) API-configured account from project settings
    let testAccount = null;

    if (authUsername && authPassword) {
      // Use credentials from action inputs
      core.info('Using auth credentials from action inputs');
      testAccount = {
        id: 'input-auth',
        name: 'Action Input Auth',
        role: 'user',
        email: authUsername,
        password: authPassword,
        auth_type: 'form' as const,
        login_url: authLoginUrl,
        email_selector: authEmailSelector || undefined,
        password_selector: authPasswordSelector || undefined,
        submit_selector: authSubmitSelector || undefined,
        success_indicator: authSuccessIndicator || undefined,
        is_default: true,
        is_active: true,
      };
    } else {
      // Try to fetch from API (project settings configured via UI)
      core.info('Checking for test account in project settings...');
      testAccount = await client.getDefaultTestAccount(projectId);
      if (testAccount) {
        core.info(`Found test account: ${testAccount.name} (${testAccount.role})`);
      } else {
        core.info('No test account configured - running without authentication');
      }
    }

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

    // Build crawl credentials from test account (action inputs or API-configured)
    let crawlCredentials: CrawlCredentials | undefined;
    if (testAccount && testAccount.auth_type === 'form') {
      crawlCredentials = {
        email: testAccount.email,
        password: testAccount.password,
        loginUrl: testAccount.login_url || '/login',
        emailSelector: testAccount.email_selector || undefined,
        passwordSelector: testAccount.password_selector || undefined,
        submitSelector: testAccount.submit_selector || undefined,
        successIndicator: testAccount.success_indicator || undefined,
      };
      core.info(`Crawling with authentication (${testAccount.name})`);
    } else if (testAccount) {
      core.info(`Test account auth_type is '${testAccount.auth_type}' - crawler only supports 'form' auth, crawling anonymously`);
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
