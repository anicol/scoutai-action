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
export declare function createRegressionIssue(regression: RegressionIssue): Promise<string | null>;
/**
 * Create issues for all failed flows in the results.
 */
export declare function createIssuesForFailures(results: ResultPayload[], runId: string, prNumber?: number, commitSha?: string, branch?: string): Promise<string[]>;
//# sourceMappingURL=issues.d.ts.map