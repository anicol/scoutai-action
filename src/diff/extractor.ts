import * as github from '@actions/github';
import * as core from '@actions/core';
import { DiffMetadata, DiffFile } from '../api/client';

export async function extractDiffMetadata(): Promise<DiffMetadata> {
  const context = github.context;
  const token = process.env.GITHUB_TOKEN;

  core.debug(`Event: ${context.eventName}`);
  core.debug(`Ref: ${context.ref}`);
  core.debug(`SHA: ${context.sha}`);

  const diffMetadata: DiffMetadata = {
    files: [],
    commit_sha: context.sha,
    branch: context.ref.replace('refs/heads/', ''),
  };

  // Handle pull request events
  if (context.eventName === 'pull_request' && context.payload.pull_request) {
    const pr = context.payload.pull_request;
    diffMetadata.pr_number = pr.number;
    diffMetadata.pr_title = pr.title;
    diffMetadata.branch = pr.head.ref;

    if (token) {
      const octokit = github.getOctokit(token);
      const files = await getPullRequestFiles(octokit, context, pr.number);
      diffMetadata.files = files;
    }
  }
  // Handle push events
  else if (context.eventName === 'push' && token) {
    const octokit = github.getOctokit(token);
    const files = await getCommitFiles(octokit, context);
    diffMetadata.files = files;
  }
  // Handle schedule/workflow_dispatch - get recent changes
  else if (context.eventName === 'schedule' || context.eventName === 'workflow_dispatch') {
    // For scheduled runs, we don't have specific files
    // The AI will determine what to test based on flows
    core.info('Scheduled/manual run - testing all flows');
  }

  core.info(`Extracted ${diffMetadata.files.length} changed files`);
  return diffMetadata;
}

async function getPullRequestFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number
): Promise<DiffFile[]> {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return files.map(file => ({
    path: file.filename,
    status: mapFileStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
  }));
}

async function getCommitFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context
): Promise<DiffFile[]> {
  const { data: commit } = await octokit.rest.repos.getCommit({
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref: context.sha,
  });

  return (commit.files || []).map(file => ({
    path: file.filename,
    status: mapFileStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
  }));
}

function mapFileStatus(status: string): DiffFile['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

/**
 * Extract likely URL paths from changed file paths.
 * Maps common file naming conventions to URL routes.
 *
 * Examples:
 * - src/pages/Dashboard/MultiStore.tsx -> /dashboard/multi-store
 * - app/dashboard/settings/page.tsx -> /dashboard/settings
 * - components/StorePerformance.tsx -> (no URL, component only)
 */
export function extractLikelyUrls(files: DiffFile[]): string[] {
  const urls = new Set<string>();

  for (const file of files) {
    const path = file.path.toLowerCase();

    // Skip non-UI files
    if (!path.match(/\.(tsx?|jsx?|vue|svelte)$/)) continue;
    // Skip test files
    if (path.includes('test') || path.includes('spec') || path.includes('__tests__')) continue;

    // Next.js app router: app/dashboard/settings/page.tsx -> /dashboard/settings
    const appRouterMatch = path.match(/app\/(.+?)\/page\.(tsx?|jsx?)$/);
    if (appRouterMatch) {
      const route = '/' + appRouterMatch[1].replace(/\[([^\]]+)\]/g, ':$1');
      urls.add(route);
      continue;
    }

    // Next.js pages router: pages/dashboard/index.tsx -> /dashboard
    const pagesMatch = path.match(/pages\/(.+?)\.(tsx?|jsx?)$/);
    if (pagesMatch) {
      let route = '/' + pagesMatch[1].replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1');
      if (route === '/') route = '/';
      urls.add(route);
      continue;
    }

    // Generic: src/pages/Dashboard/MultiStore.tsx -> /dashboard/multi-store
    const genericPagesMatch = path.match(/(?:src\/)?(?:pages|views|screens)\/(.+?)\.(tsx?|jsx?|vue|svelte)$/);
    if (genericPagesMatch) {
      // Convert PascalCase/camelCase to kebab-case
      const route = '/' + genericPagesMatch[1]
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[/\\]/g, '/')
        .replace(/\/index$/i, '')
        .toLowerCase();
      urls.add(route);
      continue;
    }

    // Routes folder: src/routes/dashboard.tsx -> /dashboard
    const routesMatch = path.match(/(?:src\/)?routes\/(.+?)\.(tsx?|jsx?|vue|svelte)$/);
    if (routesMatch) {
      const route = '/' + routesMatch[1]
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/\/index$/i, '')
        .toLowerCase();
      urls.add(route);
      continue;
    }
  }

  return Array.from(urls);
}
