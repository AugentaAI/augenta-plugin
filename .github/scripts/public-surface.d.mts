export interface PublicFinding { location: string; rule: string }
export interface AuditEvent {
  before?: string;
  pull_request?: {
    title?: string;
    body?: string | null;
    base: { sha: string };
    head: { sha: string; ref?: string };
  };
}
export function publicTextFindings(text: string): string[];
export function auditPublicSurface(options?: {
  root?: string;
  event?: AuditEvent;
  commits?: string;
}): PublicFinding[];
