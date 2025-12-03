import * as core from '@actions/core';
import * as github from '@actions/github';
import { ResultPayload, TestPlan, DiffFile } from '../api/client';

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
}

export function calculateSummary(results: ResultPayload[]): TestSummary {
  return {
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
  };
}

export async function postPRComment(
  testPlan: TestPlan,
  results: ResultPayload[],
  runId: string,
  dashboardUrl?: string
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('GITHUB_TOKEN not set, skipping PR comment');
    return;
  }

  const context = github.context;
  if (context.eventName !== 'pull_request' || !context.payload.pull_request) {
    core.debug('Not a PR event, skipping comment');
    return;
  }

  const summary = calculateSummary(results);
  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;

  const statusEmoji = summary.failed > 0 ? '❌' : '✅';
  const duration = (summary.duration_ms / 1000).toFixed(1);

  let body = `## ${statusEmoji} ScoutAI QA Results\n\n`;
  body += `| Metric | Value |\n`;
  body += `|--------|-------|\n`;
  body += `| ✅ Passed | ${summary.passed} |\n`;
  body += `| ❌ Failed | ${summary.failed} |\n`;
  body += `| ⏭️ Skipped | ${summary.skipped} |\n`;
  body += `| ⏱️ Duration | ${duration}s |\n`;
  body += `| 🎯 Risk Score | ${testPlan.risk_score}/10 |\n\n`;

  if (results.length > 0) {
    // Group results by viewport
    const viewports = [...new Set(results.map(r => r.viewport || 'desktop'))];

    if (viewports.length > 1) {
      // Multiple viewports - group by viewport
      for (const viewport of viewports) {
        const viewportResults = results.filter(r => (r.viewport || 'desktop') === viewport);
        const viewportIcon = viewport === 'mobile' ? '📱' : '🖥️';
        const viewportLabel = viewport.charAt(0).toUpperCase() + viewport.slice(1);

        body += `### ${viewportIcon} ${viewportLabel} Results\n\n`;
        for (const result of viewportResults) {
          const icon = result.status === 'passed' ? '✅' : result.status === 'failed' ? '❌' : '⏭️';
          body += `${icon} **${result.flow_name}** (${(result.duration_ms / 1000).toFixed(1)}s)\n`;
          if (result.error_message) {
            body += `> ${result.error_message}\n`;
          }
        }
        body += '\n';
      }
    } else {
      // Single viewport - simple list
      body += `### Flow Results\n\n`;
      for (const result of results) {
        const icon = result.status === 'passed' ? '✅' : result.status === 'failed' ? '❌' : '⏭️';
        body += `${icon} **${result.flow_name}** (${(result.duration_ms / 1000).toFixed(1)}s)\n`;
        if (result.error_message) {
          body += `> ${result.error_message}\n`;
        }
      }
      body += '\n';
    }
  }

  if (dashboardUrl) {
    body += `[View detailed results →](${dashboardUrl}/runs/${runId})\n\n`;
  }

  body += `---\n`;
  body += `*Powered by [ScoutAI](https://github.com/anicol/scout-ai) - Autonomous QA Agent*`;

  // Look for existing ScoutAI comment to update
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: prNumber,
  });

  const existingComment = comments.find(
    c => c.body?.includes('ScoutAI QA Results')
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingComment.id,
      body,
    });
    core.info(`Updated PR comment #${existingComment.id}`);
  } else {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
    core.info('Created PR comment');
  }
}

export function setOutputs(
  runId: string,
  status: 'passed' | 'failed' | 'error',
  summary: TestSummary
): void {
  core.setOutput('run-id', runId);
  core.setOutput('status', status);
  core.setOutput('summary', JSON.stringify(summary));
}

export async function postSkippedPRComment(
  changeDescription: string,
  files: DiffFile[]
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('GITHUB_TOKEN not set, skipping PR comment');
    return;
  }

  const context = github.context;
  if (context.eventName !== 'pull_request' || !context.payload.pull_request) {
    core.debug('Not a PR event, skipping comment');
    return;
  }

  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;

  // Build file list (max 10)
  const fileList = files.slice(0, 10).map(f => `- \`${f.path}\``).join('\n');
  const moreFiles = files.length > 10 ? `\n- ... and ${files.length - 10} more files` : '';

  let body = `## ⏭️ ScoutAI QA - Skipped\n\n`;
  body += `This PR contains only **${changeDescription}** - no user-facing tests needed.\n\n`;
  body += `<details>\n<summary>Changed files (${files.length})</summary>\n\n`;
  body += `${fileList}${moreFiles}\n`;
  body += `</details>\n\n`;
  body += `---\n`;
  body += `*Powered by [ScoutAI](https://github.com/anicol/scout-ai) - Autonomous QA Agent*`;

  // Look for existing ScoutAI comment to update
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: prNumber,
  });

  const existingComment = comments.find(
    c => c.body?.includes('ScoutAI QA')
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingComment.id,
      body,
    });
    core.info(`Updated PR comment #${existingComment.id} (skipped)`);
  } else {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
    core.info('Created PR comment (skipped)');
  }
}
