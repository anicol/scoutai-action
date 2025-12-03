import { FlowPlan, ResultPayload, TestAccount } from '../api/client';
export declare class PlaywrightExecutor {
    private browser;
    private baseUrl;
    private screenshotDir;
    private testAccount;
    private storageState;
    constructor(baseUrl: string, screenshotDir?: string);
    setTestAccount(account: TestAccount | null): void;
    initialize(): Promise<void>;
    /**
     * Authenticate using the configured test account.
     * Saves session state to reuse across flows.
     */
    private authenticate;
    cleanup(): Promise<void>;
    executeFlow(flow: FlowPlan, viewport?: string): Promise<ResultPayload>;
    private executeStep;
    /**
     * Smart locator that handles multiple selector types:
     * - If selector contains comma with mixed types (CSS + text), try each separately
     * - text="..." -> use getByText
     * - CSS selectors -> use locator()
     */
    private smartLocator;
    private singleLocator;
}
export declare function executeFlows(flows: FlowPlan[], baseUrl: string, maxDurationMs?: number, testAccount?: TestAccount | null, viewports?: string[]): Promise<ResultPayload[]>;
//# sourceMappingURL=playwright.d.ts.map