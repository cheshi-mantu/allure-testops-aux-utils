/** Rolling a test case back to how it was at a point in time, from its change log. */

export interface ValueChange<T> {
  oldValue?: T | null;
  newValue?: T | null;
}

/** An entry of `GET /api/rs/testcase/audit`, newest first. */
export interface AuditEntry {
  id: number;
  timestamp: number;
  username?: string | null;
  /** `insert`, `update` or `delete`. */
  actionType: string;
  data?: { type: string; diff?: Record<string, ValueChange<unknown> | null> | null }[] | null;
}

export interface Named {
  id: number;
  name: string;
}

/** The parts of `GET /api/rs/testcase/{id}/overview` a rollback looks at. */
export interface Overview {
  id: number;
  name: string;
  fullName?: string | null;
  description?: string | null;
  precondition?: string | null;
  expectedResult?: string | null;
  automated?: boolean | null;
  status?: Named | null;
  workflow?: Named | null;
  layer?: Named | null;
  tags?: Named[] | null;
  issues?: (Named & { integrationId?: number | null })[] | null;
  members?: (Named & { role?: Named | null })[] | null;
  customFields?: (Named & { customField?: Named | null })[] | null;
}

export const SCALARS = ["name", "fullName", "description", "precondition", "expectedResult", "automated", "workflow", "status", "layer"] as const;
export const LISTS = ["tags", "customFields", "members", "issues"] as const;
export type ScalarKey = (typeof SCALARS)[number];
export type ListKey = (typeof LISTS)[number];
export type AttributeKey = ScalarKey | ListKey;
export const ATTRIBUTES: AttributeKey[] = [...SCALARS, ...LISTS];

export const ATTRIBUTE_LABEL: Record<AttributeKey, string> = {
  name: "Name",
  fullName: "Full name",
  description: "Description",
  precondition: "Precondition",
  expectedResult: "Expected result",
  automated: "Automated",
  workflow: "Workflow",
  status: "Status",
  layer: "Layer",
  tags: "Tags",
  customFields: "Custom fields",
  members: "Members",
  issues: "Issues",
};

/** Attributes rolled back unless chosen otherwise; the full name ties a test case to its automated results. */
export const DEFAULT_ATTRIBUTES: AttributeKey[] = ATTRIBUTES.filter((a) => a !== "fullName");

/** Field of a `test_case` change for each scalar attribute. */
const SCALAR_FIELD: Record<ScalarKey, string> = {
  name: "name",
  fullName: "fullName",
  description: "description",
  precondition: "precondition",
  expectedResult: "expectedResult",
  automated: "automated",
  workflow: "workflowId",
  status: "statusId",
  layer: "testLayerId",
};

/** Change log entry type of each list attribute. */
const LIST_TYPE: Record<ListKey, string> = {
  tags: "test_case_test_tag",
  customFields: "test_case_custom_field",
  members: "test_case_members",
  issues: "test_case_issue",
};

type Scalar = string | number | boolean | null;

/** A value of an attribute: scalars as they are, references and lists as ids. */
export type RawValue = Scalar | number[];

export function currentRaw(o: Overview, a: AttributeKey): RawValue {
  switch (a) {
    case "workflow":
      return o.workflow?.id ?? null;
    case "status":
      return o.status?.id ?? null;
    case "layer":
      return o.layer?.id ?? null;
    case "tags":
    case "customFields":
    case "members":
    case "issues":
      return sortedIds((o[a] ?? []).map((x) => x.id));
    default:
      return o[a] ?? null;
  }
}

const sortedIds = (ids: Iterable<number>) => [...new Set(ids)].sort((x, y) => x - y);

export function sameRaw(a: RawValue, b: RawValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  // An empty text and no text are the same to the user.
  return (a ?? "") === (b ?? "");
}

export interface Rewind {
  /** Values at the point in time, of the attributes changed since. */
  target: Partial<Record<AttributeKey, RawValue>>;
  /** The test case did not exist at that time. */
  createdAfter: boolean;
  /** People who changed the test case since, with the number of their changes. */
  authors: Record<string, number>;
  changes: number;
}

/**
 * Undoes the changes logged after `after`, newest first, starting from the
 * current state. Entries must be the ones after that time, newest first.
 */
export function rewind(current: Overview, entries: AuditEntry[], after: number, attributes: AttributeKey[]): Rewind {
  const wanted = new Set(attributes);
  const scalars = new Map<ScalarKey, Scalar>();
  const lists = new Map<ListKey, Set<number>>();
  const authors: Record<string, number> = {};
  let createdAfter = false;
  let changes = 0;
  for (const e of entries) {
    if (e.timestamp <= after) break;
    changes++;
    // Allure TestOps writes actions and types in lower case; any case is taken.
    const action = String(e.actionType).toLowerCase();
    const who = e.username || "unknown";
    authors[who] = (authors[who] ?? 0) + 1;
    for (const d of e.data ?? []) {
      const type = String(d.type).toLowerCase();
      if (type === "test_case") {
        if (action === "insert") createdAfter = true;
        if (action !== "update") continue;
        for (const a of SCALARS) {
          const change = d.diff?.[SCALAR_FIELD[a]];
          // Older entries come later: the oldest change after the time holds the value at that time.
          if (wanted.has(a) && change) scalars.set(a, (change.oldValue ?? null) as Scalar);
        }
        continue;
      }
      const list = LISTS.find((l) => LIST_TYPE[l] === type);
      if (!list || !wanted.has(list)) continue;
      const ids = d.diff?.ids;
      if (!lists.has(list)) lists.set(list, new Set(currentRaw(current, list) as number[]));
      const set = lists.get(list)!;
      // Undo: what was added goes, what was removed comes back.
      if (action === "insert") for (const id of (ids?.newValue as number[] | null) ?? []) set.delete(id);
      if (action === "delete") for (const id of (ids?.oldValue as number[] | null) ?? []) set.add(id);
    }
  }
  const target: Partial<Record<AttributeKey, RawValue>> = {};
  for (const [a, v] of scalars) if (!sameRaw(v, currentRaw(current, a))) target[a] = v;
  for (const [a, v] of lists) {
    const ids = sortedIds(v);
    if (!sameRaw(ids, currentRaw(current, a))) target[a] = ids;
  }
  return { target, createdAfter, authors, changes };
}
