/** Reading test results of a launch, shared by the exports. */
import type { JobContext } from "../jobs.js";
import { TestOpsError, type TestOpsClient } from "../testops.js";
import type {
  ApiCustomFieldWithValues,
  ApiEnvVarValue,
  ApiFixture,
  ApiIssue,
  ApiMember,
  ApiScenario,
  ApiTestResult,
  ResultDetails,
} from "./api.js";
import type { AttachmentOwner } from "./convert.js";

const MAX_WARNINGS_PER_KIND = 20;

export const CONTENT_PATH: Record<AttachmentOwner, string> = {
  result: "/api/rs/testresult/attachment",
  fixture: "/api/rs/testfixtureresult/attachment",
};

export function attachmentContentPath(owner: AttachmentOwner, id: number): string {
  return `${CONTENT_PATH[owner]}/${id}/content`;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type Warn = (kind: string, line: string) => void;

/** Warnings of a job, at most a few of each kind; `flush` reports how many were left out. */
export function warner(ctx: JobContext): { warn: Warn; flush: () => void } {
  const counts = new Map<string, number>();
  return {
    warn(kind, line) {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      if (n <= MAX_WARNINGS_PER_KIND) ctx.warn(line);
    },
    flush() {
      for (const [kind, n] of counts) {
        if (n > MAX_WARNINGS_PER_KIND) ctx.warn(`… and ${n - MAX_WARNINGS_PER_KIND} more warnings of this kind (${kind})`);
      }
    },
  };
}

export function checkCancelled(ctx: JobContext): void {
  if (ctx.signal.aborted) throw new Error("Cancelled");
}

/**
 * Steps, fixtures, custom fields, members and issues of a test result, plus
 * its environment when asked. A part that cannot be read is left empty with a warning.
 */
export async function readResultDetails(client: TestOpsClient, result: ApiTestResult, warn: Warn, withEnvironment = false): Promise<ResultDetails> {
  const part = <T>(what: string, path: string, fallback: T, params: Record<string, string> = {}) =>
    client.get<T>(path, params).catch((e: unknown) => {
      if (!(e instanceof TestOpsError && e.status === 404)) warn(what, `Test result ${result.id} "${result.name}": ${what} not exported: ${message(e)}`);
      return fallback;
    });
  const id = result.id;
  const [scenario, fixtures, customFields, members, issues, environment] = await Promise.all([
    part<ApiScenario | null>("steps", `/api/rs/testresult/${id}/execution`, null, { v2: "true" }),
    part<ApiFixture[]>("fixtures", `/api/rs/testresult/${id}/fixture`, [], { v2: "true" }),
    part<ApiCustomFieldWithValues[]>("custom fields", `/api/rs/testresult/${id}/cfv`, [], { v2: "true" }),
    part<ApiMember[]>("members", `/api/rs/testresult/${id}/members`, []),
    part<ApiIssue[]>("issues", `/api/rs/testresult/${id}/issue`, []),
    withEnvironment ? part<ApiEnvVarValue[]>("environment", `/api/rs/testresult/${id}/evv`, []) : Promise.resolve([]),
  ]);
  return {
    result,
    scenario,
    fixtures: fixtures ?? [],
    customFields: customFields ?? [],
    members: members ?? [],
    issues: issues ?? [],
    environment: environment ?? [],
  };
}
