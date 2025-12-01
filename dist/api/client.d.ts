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
export declare class ScoutAIClient {
    private apiKey;
    private baseUrl;
    constructor(apiKey: string, baseUrl?: string);
    private request;
    getProjectByRepo(githubRepo: string): Promise<Project | null>;
    createProject(name: string, githubRepo: string, baseUrl?: string): Promise<Project>;
    generatePlan(projectId: string, diffMetadata: DiffMetadata, mode: 'fast' | 'deep', baseUrl: string, siteContext?: SiteContext): Promise<PlanResponse>;
    startRun(runId: string): Promise<void>;
    completeRun(runId: string, status: 'passed' | 'failed' | 'error', summary: {
        passed: number;
        failed: number;
        skipped: number;
    }): Promise<void>;
    uploadResults(runId: string, results: ResultPayload[]): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map