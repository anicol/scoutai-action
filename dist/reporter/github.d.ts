import { ResultPayload, TestPlan, DiffFile } from '../api/client';
export interface TestSummary {
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
}
export declare function calculateSummary(results: ResultPayload[]): TestSummary;
export declare function postPRComment(testPlan: TestPlan, results: ResultPayload[], runId: string, dashboardUrl?: string): Promise<void>;
export declare function setOutputs(runId: string, status: 'passed' | 'failed' | 'error', summary: TestSummary): void;
export declare function postSkippedPRComment(changeDescription: string, files: DiffFile[]): Promise<void>;
//# sourceMappingURL=github.d.ts.map