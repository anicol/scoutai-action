import * as core from '@actions/core';
import { PageContext } from '../crawler';

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface DiffMetadata {
  files: DiffFile[];
  pr_number?: number;
  pr_title?: string;
  commit_sha: string;
  branch?: string;
}

export interface SiteContext {
  pages: PageContext[];
}

export interface PlaywrightStep {
  action: string;
  selector?: string;
  value?: string;
  description: string;
}

export interface FlowPlan {
  id: string;
  name: string;
  priority: number;
  reasoning: string;
  steps: PlaywrightStep[];
}

export interface TestPlan {
  flows: FlowPlan[];
  risk_score: number;
}

export interface PlanResponse {
  run_id: string;
  test_plan: TestPlan;
  stream_url: string;
}

export interface ResultPayload {
  flow_name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms: number;
  error_message?: string;
  steps: StepResult[];
  screenshot_urls: string[];
  viewport?: string;  // 'desktop' | 'mobile'
}

export interface StepResult {
  description: string;
  status: 'passed' | 'failed';
  duration_ms: number;
  error?: string;
}

export interface Project {
  id: string;
  name: string;
  github_repo: string;
  base_url?: string;
}

export interface TestAccount {
  id: string;
  name: string;
  role: string;
  email: string;
  password: string;  // Only returned for authenticated requests
  auth_type: 'form' | 'oauth' | 'api_key' | 'basic';
  login_url: string;
  email_selector?: string;
  password_selector?: string;
  submit_selector?: string;
  success_indicator?: string;
  is_default: boolean;
  is_active: boolean;
}

export class ScoutAIClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string = 'https://scoutai-api.onrender.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    core.debug(`API Request: ${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async getProjectByRepo(githubRepo: string): Promise<Project | null> {
    const projects = await this.request<Project[]>('GET', '/api/projects/');
    return projects.find(p => p.github_repo === githubRepo) || null;
  }

  async createProject(name: string, githubRepo: string, baseUrl?: string): Promise<Project> {
    return this.request<Project>('POST', '/api/projects/', {
      name,
      github_repo: githubRepo,
      base_url: baseUrl,
    });
  }

  async generatePlan(
    projectId: string,
    diffMetadata: DiffMetadata,
    mode: 'fast' | 'deep',
    baseUrl: string,
    siteContext?: SiteContext,
    environment?: string,
    trigger?: string
  ): Promise<PlanResponse> {
    return this.request<PlanResponse>('POST', '/api/plan/', {
      project_id: projectId,
      diff_metadata: diffMetadata,
      mode,
      base_url: baseUrl,
      site_context: siteContext,
      environment,
      trigger,
    });
  }

  async startRun(runId: string): Promise<void> {
    await this.request('POST', `/api/runs/${runId}/start/`);
  }

  async completeRun(
    runId: string,
    status: 'passed' | 'failed' | 'error',
    summary: { passed: number; failed: number; skipped: number }
  ): Promise<void> {
    await this.request('POST', `/api/runs/${runId}/complete/`, {
      status,
      summary,
    });
  }

  async uploadResults(runId: string, results: ResultPayload[]): Promise<void> {
    await this.request('POST', `/api/runs/${runId}/results/`, {
      results,
    });
  }

  async getDefaultTestAccount(projectId: string): Promise<TestAccount | null> {
    try {
      return await this.request<TestAccount>(
        'GET',
        `/api/projects/${projectId}/test-accounts/default/`
      );
    } catch (error) {
      // No test account configured - that's okay
      return null;
    }
  }

  async getTestAccounts(projectId: string): Promise<TestAccount[]> {
    return this.request<TestAccount[]>(
      'GET',
      `/api/projects/${projectId}/test-accounts/`
    );
  }
}
