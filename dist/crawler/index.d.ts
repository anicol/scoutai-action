export interface PageContext {
    url: string;
    title: string;
    html: string;
    links: LinkInfo[];
    forms: FormInfo[];
    buttons: ButtonInfo[];
    inputs: InputInfo[];
}
export interface LinkInfo {
    href: string;
    text: string;
    selector: string;
}
export interface FormInfo {
    action: string;
    method: string;
    selector: string;
    inputs: InputInfo[];
}
export interface ButtonInfo {
    text: string;
    type: string;
    selector: string;
}
export interface InputInfo {
    name: string;
    type: string;
    placeholder: string;
    selector: string;
    label?: string;
}
/**
 * Crawl a page and extract structured information about interactive elements.
 * This gives Claude real context about what's on the page.
 */
export declare function crawlPage(url: string): Promise<PageContext>;
/**
 * Crawl multiple pages to build a site map.
 * @param baseUrl - The base URL to start crawling from
 * @param maxPages - Maximum number of pages to crawl
 * @param priorityPaths - URL paths to crawl first (e.g., ['/dashboard/multi-store'])
 */
export declare function crawlSite(baseUrl: string, maxPages?: number, priorityPaths?: string[]): Promise<PageContext[]>;
//# sourceMappingURL=index.d.ts.map