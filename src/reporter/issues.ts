import * as core from '@actions/core';
import * as github from '@actions/github';
import { ResultPayload } from '../api/client';

export interface RegressionIssue {
  title: string;
  flowName: string;
  errorMessage: string;
  screenshots: string[];
  steps: Array<{
    description: string;
    status: string;
    duration_ms: number;
    error?: string;
  }>;
  runId: string;
  prNumber?: number;
  commitSha?: string;
  branch?: string;
}

/**
 * Create a GitHub Issue for a test failure/regression.
 */
export async function createRegressionIssue(
  regression: RegressionIssue
): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('GITHUB_TOKEN not set, cannot create issue');
    return null;
  }

  const context = github.context;
  const octokit = github.getOctokit(token);

  // Build the issue body
  const stepsMarkdown = regression.steps
    .map((s, i) => {
      const icon = s.status === 'passed' ? '✅' : '❌';
      const error = s.error ? `\n   > Error: ${s.error}` : '';
      return `${i + 1}. ${icon} ${s.description} (${(s.duration_ms / 1000).toFixed(1)}s)${error}`;
    })
    .join('\n');

  // For screenshots, we can't embed base64 in issues, so we note they're available
  const screenshotSection = regression.screenshots.length > 0
    ? `### Screenshots\n${regression.screenshots.length} screenshot(s) captured. View them in the [ScoutAI Dashboard](https://scoutai.app/runs/${regression.runId}).`
    : '';

  const contextLines = [
    `- **Run ID**: \`${regression.runId}\``,
    regression.prNumber ? `- **PR**: #${regression.prNumber}` : null,
    regression.commitSha ? `- **Commit**: \`${regression.commitSha.slice(0, 7)}\`` : null,
    regression.branch ? `- **Branch**: \`${regression.branch}\`` : null,
    `- **Triggered at**: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');

  const body = `## Test Failure Detected

**Flow**: ${regression.flowName}
**Error**: ${regression.errorMessage}

### Steps to Reproduce

${stepsMarkdown}

${screenshotSection}

### Context

${contextLines}

---
*Created automatically by [ScoutAI](https://github.com/anicol/scout-ai) - Autonomous QA Agent*
`;

  try {
    // Check for existing issue to avoid duplicates
    const { data: existingIssues } = await octokit.rest.issues.listForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      labels: 'scoutai,regression',
      state: 'open',
    });

    const duplicateIssue = existingIssues.find(issue =>
      issue.title.includes(regression.flowName)
    );

    if (duplicateIssue) {
      // Add a comment to existing issue instead
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: duplicateIssue.number,
        body: `### Regression still occurring\n\n${body}`,
      });
      core.info(`Updated existing issue #${duplicateIssue.number} for ${regression.flowName}`);
      return duplicateIssue.html_url;
    }

    // Create new issue
    const { data: issue } = await octokit.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: `[ScoutAI] ${regression.title}`,
      body,
      labels: ['scoutai', 'regression', 'automated'],
    });

    core.info(`Created issue #${issue.number} for ${regression.flowName}`);
    return issue.html_url;
  } catch (error) {
    core.warning(`Failed to create issue: ${error}`);
    return null;
  }
}

/**
 * Create issues for all failed flows in the results.
 */
export async function createIssuesForFailures(
  results: ResultPayload[],
  runId: string,
  prNumber?: number,
  commitSha?: string,
  branch?: string
): Promise<string[]> {
  const failedFlows = results.filter(r => r.status === 'failed');

  if (failedFlows.length === 0) {
    return [];
  }

  core.info(`Creating issues for ${failedFlows.length} failed flow(s)...`);

  const issueUrls: string[] = [];

  for (const flow of failedFlows) {
    const issueUrl = await createRegressionIssue({
      title: `Test failure: ${flow.flow_name}`,
      flowName: flow.flow_name,
      errorMessage: flow.error_message || 'Test assertion failed',
      screenshots: flow.screenshot_urls || [],
      steps: flow.steps,
      runId,
      prNumber,
      commitSha,
      branch,
    });

    if (issueUrl) {
      issueUrls.push(issueUrl);
    }
  }

  return issueUrls;
}
