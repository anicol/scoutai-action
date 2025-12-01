import { FlowPlan, ResultPayload } from '../api/client';
export declare class PlaywrightExecutor {
    private browser;
    private baseUrl;
    private screenshotDir;
    constructor(baseUrl: string, screenshotDir?: string);
    initialize(): Promise<void>;
    cleanup(): Promise<void>;
    executeFlow(flow: FlowPlan): Promise<ResultPayload>;
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
export declare function executeFlows(flows: FlowPlan[], baseUrl: string, maxDurationMs?: number): Promise<ResultPayload[]>;
//# sourceMappingURL=playwright.d.ts.map