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
    viewport?: string;
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
    password: string;
    auth_type: 'form' | 'oauth' | 'api_key' | 'basic';
    login_url: string;
    email_selector?: string;
    password_selector?: string;
    submit_selector?: string;
    success_indicator?: string;
    is_default: boolean;
    is_active: boolean;
}
export interface TypeFile {
    path: string;
    content: string;
}
export interface SchemaFiles {
    openapi?: object;
    graphql?: string;
    prisma?: string;
}
export interface TestPatterns {
    sample_tests: TypeFile[];
    config?: object;
    fixtures?: TypeFile[];
}
export interface ChangedFile {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    content: string;
    previous_content?: string;
}
export interface FileDependency {
    file: string;
    imports: string[];
    imported_by: string[];
}
export interface CodebaseContext {
    project: {
        language: string;
        framework?: string;
        test_framework?: string;
        package_json?: object;
    };
    types: TypeFile[];
    schemas: SchemaFiles;
    test_patterns: TestPatterns;
    diff: {
        files: ChangedFile[];
        base_sha: string;
        head_sha: string;
    };
    dependencies: FileDependency[];
}
export interface ScoutTestAnalyzeResponse {
    run_id: string;
    status: 'pending' | 'analyzing' | 'ready' | 'executing' | 'completed' | 'error';
    risk_score: number;
    risk_factors: Record<string, unknown>;
    coverage_gaps: string[];
}
export interface GeneratedTest {
    id: string;
    test_type: 'unit' | 'api' | 'integration';
    name: string;
    test_code: string;
    test_framework: string;
    target_file: string;
}
export interface ScoutTestRunResponse {
    id: string;
    status: string;
    risk_score: number;
    merge_recommendation?: 'recommend' | 'caution' | 'block';
    recommendation_reason?: string;
    tests: GeneratedTest[];
}
export interface TestResult {
    test_id: string;
    status: 'passed' | 'failed' | 'skipped';
    duration_ms: number;
    error_message?: string;
    stdout?: string;
    stderr?: string;
}
export declare class ScoutAIClient {
    private apiKey;
    private baseUrl;
    constructor(apiKey: string, baseUrl?: string);
    private request;
    getProjectByRepo(githubRepo: string): Promise<Project | null>;
    createProject(name: string, githubRepo: string, baseUrl?: string): Promise<Project>;
    generatePlan(projectId: string, diffMetadata: DiffMetadata, mode: 'fast' | 'deep', baseUrl: string, siteContext?: SiteContext, environment?: string, trigger?: string): Promise<PlanResponse>;
    startRun(runId: string): Promise<void>;
    completeRun(runId: string, status: 'passed' | 'failed' | 'error', summary: {
        passed: number;
        failed: number;
        skipped: number;
    }): Promise<void>;
    uploadResults(runId: string, results: ResultPayload[]): Promise<void>;
    getDefaultTestAccount(projectId: string): Promise<TestAccount | null>;
    getTestAccounts(projectId: string): Promise<TestAccount[]>;
    analyzeForScoutTest(projectId: string, context: CodebaseContext, prNumber?: number, prTitle?: string): Promise<ScoutTestAnalyzeResponse>;
    getScoutTestRun(runId: string): Promise<ScoutTestRunResponse>;
    getScoutTestTests(runId: string): Promise<GeneratedTest[]>;
    reportScoutTestResults(runId: string, results: TestResult[]): Promise<void>;
    waitForScoutTestReady(runId: string, timeoutMs?: number, pollIntervalMs?: number): Promise<ScoutTestRunResponse>;
}
//# sourceMappingURL=client.d.ts.map