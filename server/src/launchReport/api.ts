/** Shapes of the Allure TestOps API responses used by the launch report export. */

export type ApiStatus = "passed" | "failed" | "broken" | "skipped" | "unknown";

export interface ApiLaunch {
  id: number;
  name: string;
  projectId: number;
  closed?: boolean;
  createdDate?: number;
  createdBy?: string;
  tags?: { id: number; name: string }[];
  links?: ApiLink[];
  issues?: ApiIssue[];
  statistic?: { status: ApiStatus | null; count: number }[] | null;
}

export interface ApiEnvVarValue {
  id?: number;
  name: string;
  variable?: { id?: number; name: string } | null;
}

export interface ApiLink {
  name?: string | null;
  url?: string | null;
  type?: string | null;
}

export interface ApiIssue {
  id?: number;
  name: string;
  url?: string | null;
  summary?: string | null;
}

export interface ApiParameter {
  name: string;
  value?: string | null;
  hidden?: boolean;
  excluded?: boolean;
}

export interface ApiTestResult {
  id: number;
  projectId?: number;
  launchId?: number;
  testCaseId?: number | null;
  historyKey?: string | null;
  name: string;
  fullName?: string | null;
  description?: string | null;
  descriptionHtml?: string | null;
  precondition?: string | null;
  expectedResult?: string | null;
  start?: number | null;
  stop?: number | null;
  duration?: number | null;
  /** null while the result is still in progress. */
  status?: ApiStatus | null;
  layer?: { id: number; name: string } | null;
  message?: string | null;
  trace?: string | null;
  manual?: boolean;
  hostId?: string | null;
  threadId?: string | null;
  flaky?: boolean;
  muted?: boolean;
  known?: boolean;
  /** A retry replaced by a later result of the same test. */
  hidden?: boolean;
  parameters?: ApiParameter[] | null;
  tags?: { id?: number; name: string }[] | null;
  links?: ApiLink[] | null;
}

export interface ApiAttachmentRow {
  id: number;
  name?: string | null;
  contentType?: string | null;
  contentLength?: number | null;
  missed?: boolean | null;
}

export type ApiStep = ApiBodyStep | ApiExpectedBodyStep | ApiAttachmentStep;

interface ApiStepTiming {
  status?: ApiStatus | null;
  start?: number | null;
  stop?: number | null;
  duration?: number | null;
}

export interface ApiBodyStep extends ApiStepTiming {
  type: "body";
  body?: string | null;
  message?: string | null;
  trace?: string | null;
  parameters?: { name: string; value?: string | null }[] | null;
  steps?: ApiStep[] | null;
  expectedResultSteps?: ApiStep[] | null;
}

export interface ApiExpectedBodyStep extends ApiStepTiming {
  type: "expected_body";
  body?: string | null;
  message?: string | null;
}

export interface ApiAttachmentStep extends ApiStepTiming {
  type: "attachment";
  attachmentId?: number | null;
  attachment?: ApiAttachmentRow | null;
}

export interface ApiScenario {
  steps?: ApiStep[] | null;
}

export interface ApiFixture {
  id: number;
  type: "before" | "after";
  name?: string | null;
  start?: number | null;
  stop?: number | null;
  status?: ApiStatus | null;
  message?: string | null;
  trace?: string | null;
  scenario?: ApiScenario | null;
}

export interface ApiCustomFieldWithValues {
  customField: { id: number; name: string };
  values?: { id?: number; name: string }[] | null;
}

export interface ApiMember {
  name: string;
  role?: { id?: number; name: string } | null;
}

/** Everything known about one test result. */
export interface ResultDetails {
  result: ApiTestResult;
  scenario: ApiScenario | null;
  fixtures: ApiFixture[];
  customFields: ApiCustomFieldWithValues[];
  members: ApiMember[];
  issues: ApiIssue[];
}
