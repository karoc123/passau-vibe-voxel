// One check's result, as the tools print it (PASS / FAIL, its name, the detail's key=value pairs) or give it as --json
export interface Check { name: string; pass: boolean; detail: Record<string, unknown> }
