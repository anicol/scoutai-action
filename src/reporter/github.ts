import * as core from '@actions/core';
import * as github from '@actions/github';
import { ResultPayload, TestPlan } from '../api/client';

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
