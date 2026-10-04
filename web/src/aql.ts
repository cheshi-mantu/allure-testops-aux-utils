/**
 * Launch filter conditions and their AQL. Conditions are joined with AND / OR;
 * as in AQL, AND binds tighter than OR.
 */

export type Join = "and" | "or";

export type FilterField = { kind: "tag" } | { kind: "env"; id: number; name: string };

export type Operator = "is" | "isNot" | "anyOf" | "noneOf" | "contains" | "empty" | "notEmpty";

export interface Condition {
  key: string;
  /** How the condition joins the ones before it; ignored for the first one. */
  join: Join;
  field: FilterField;
  op: Operator;
  values: string[];
}

export const OPERATORS: { value: Operator; label: string; values: 0 | 1 | "many"; env: boolean }[] = [
  { value: "is", label: "is", values: 1, env: true },
  { value: "isNot", label: "is not", values: 1, env: true },
  { value: "anyOf", label: "is any of", values: "many", env: true },
  { value: "noneOf", label: "is none of", values: "many", env: true },
  { value: "contains", label: "contains", values: 1, env: false },
  { value: "empty", label: "is not set", values: 0, env: true },
  { value: "notEmpty", label: "is set", values: 0, env: true },
];

export function operatorValues(op: Operator): 0 | 1 | "many" {
  return OPERATORS.find((o) => o.value === op)!.values;
}

export function aqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function accessor(field: FilterField): string {
  return field.kind === "tag" ? "tag" : `ev[${aqlString(field.name)}]`;
}

/** AQL of one condition, or null while it has no value yet. */
export function conditionAql(c: Condition): string | null {
  const a = accessor(c.field);
  const values = c.values.map((v) => v.trim()).filter(Boolean);
  const needs = operatorValues(c.op);
  if (needs !== 0 && values.length === 0) return null;
  const list = `[${values.map(aqlString).join(", ")}]`;
  switch (c.op) {
    case "is":
      return `${a} = ${aqlString(values[0])}`;
    case "isNot":
      return `${a} != ${aqlString(values[0])}`;
    case "anyOf":
      return values.length === 1 ? `${a} = ${aqlString(values[0])}` : `${a} in ${list}`;
    case "noneOf":
      return values.length === 1 ? `${a} != ${aqlString(values[0])}` : `not (${a} in ${list})`;
    case "contains":
      return `${a} ~= ${aqlString(values[0])}`;
    case "empty":
      return `${a} = null`;
    case "notEmpty":
      return `${a} != null`;
  }
}

/** The whole filter; conditions without values are left out. */
export function filterAql(conditions: Condition[]): string {
  let out = "";
  for (const c of conditions) {
    const aql = conditionAql(c);
    if (!aql) continue;
    out = out ? `${out} ${c.join} ${aql}` : aql;
  }
  return out;
}
