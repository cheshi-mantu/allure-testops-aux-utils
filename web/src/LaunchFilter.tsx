import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select, Space, Tooltip, Typography } from "antd";
import { CloseOutlined, EditOutlined, FilterOutlined, PlusOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { api, type IdName } from "./api";
import { filterAql, operatorValues, OPERATORS, type Condition, type FilterField, type Join, type Operator } from "./aql";

const STORAGE_KEY = "launchReport.filter";
const DEBOUNCE_MS = 400;

interface Stored {
  conditions: Condition[];
  aqlMode: boolean;
  aqlText: string;
}

function load(key: string): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "null") as Stored | null;
    if (s && Array.isArray(s.conditions)) return { conditions: s.conditions, aqlMode: Boolean(s.aqlMode), aqlText: String(s.aqlText ?? "") };
  } catch {
    // The saved filter is a convenience only.
  }
  return { conditions: [], aqlMode: false, aqlText: "" };
}

function save(key: string, s: Stored): void {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    // Same as above.
  }
}

let keySeq = 0;
const newCondition = (): Condition => ({ key: `c${Date.now()}-${keySeq++}`, join: "and", field: { kind: "tag" }, op: "is", values: [] });

/** Remote options for a select: loaded on focus and on typing, with a debounce. */
function useSuggest(fetch: (q: string) => Promise<IdName[]>, deps: unknown[]) {
  const [options, setOptions] = useState<IdName[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);
  const run = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const n = ++seq.current;
      setLoading(true);
      fetch(q)
        .then((list) => n === seq.current && setOptions(list))
        .catch(() => n === seq.current && setOptions([]))
        .finally(() => n === seq.current && setLoading(false));
    }, DEBOUNCE_MS);
  };
  // Options of another field or project are dropped.
  useEffect(() => {
    setOptions([]);
    seq.current++;
    return () => clearTimeout(timer.current);
  }, deps);
  return { options, loading, search: run };
}

function FieldSelect({ value, onChange }: { value: FilterField; onChange: (f: FilterField) => void }) {
  const { options, loading, search } = useSuggest((q) => api.envVars(q), []);
  const env = useMemo(() => {
    const list = [...options];
    if (value.kind === "env" && !list.some((v) => v.id === value.id)) list.unshift({ id: value.id, name: value.name });
    return list;
  }, [options, value]);
  return (
    <Select
      showSearch={{ filterOption: false, onSearch: search }}
      onFocus={() => search("")}
      loading={loading}
      value={value.kind === "tag" ? "tag" : `env:${value.id}`}
      onChange={(v: string) => {
        if (v === "tag") return onChange({ kind: "tag" });
        const id = Number(v.slice(4));
        const name = env.find((e) => e.id === id)?.name ?? "";
        onChange({ kind: "env", id, name });
      }}
      options={[
        { value: "tag", label: "Tag" },
        { label: "Environment variable", title: "Environment variable", options: env.map((v) => ({ value: `env:${v.id}`, label: v.name })) },
      ]}
      style={{ width: 180, flex: "none" }}
      popupMatchSelectWidth={260}
    />
  );
}

function ValueSelect({ projectId, condition, onChange }: { projectId: number; condition: Condition; onChange: (values: string[]) => void }) {
  const { field } = condition;
  const { options, loading, search } = useSuggest(
    (q) => (field.kind === "tag" ? api.launchTags(projectId, q) : api.envValues(projectId, field.id, q)),
    [projectId, field.kind, field.kind === "env" ? field.id : 0],
  );
  const single = operatorValues(condition.op) === 1;
  return (
    <Select
      mode="tags"
      maxCount={single ? 1 : undefined}
      placeholder={single ? "Value" : "Values"}
      value={condition.values}
      onChange={onChange}
      onSearch={search}
      onFocus={() => search("")}
      loading={loading}
      filterOption={false}
      options={options.map((o) => ({ value: o.name, label: o.name }))}
      style={{ minWidth: 0, flex: 1 }}
      tokenSeparators={single ? undefined : [","]}
    />
  );
}

/**
 * Filter by tags and by single environment variables, joined with AND / OR,
 * or by AQL typed by hand. Reports the AQL to apply.
 */
export function LaunchFilter({
  projectId,
  onApply,
  storageKey = STORAGE_KEY,
}: {
  projectId: number | null;
  onApply: (aql: string) => void;
  /** Where the filter is remembered; each tool keeps its own. */
  storageKey?: string;
}) {
  const initial = useMemo(() => load(storageKey), []);
  const [conditions, setConditions] = useState(initial.conditions);
  const [aqlMode, setAqlMode] = useState(initial.aqlMode);
  const [aqlText, setAqlText] = useState(initial.aqlText);
  const [appliedText, setAppliedText] = useState(initial.aqlText);
  const built = filterAql(conditions);
  const applied = aqlMode ? appliedText.trim() : built;

  useEffect(() => save(storageKey, { conditions, aqlMode, aqlText: appliedText }), [conditions, aqlMode, appliedText]);

  useEffect(() => {
    const t = setTimeout(() => onApply(applied), aqlMode ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [applied]);

  const update = (key: string, patch: Partial<Condition>) => setConditions((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  if (aqlMode) {
    return (
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 6 }}
          value={aqlText}
          onChange={(e) => setAqlText(e.target.value)}
          placeholder={'tag = "nightly" and (ev["browser"] = "chrome" or ev["browser"] = "firefox")'}
          style={{ fontFamily: "monospace" }}
        />
        <Space wrap>
          <Button type="primary" icon={<FilterOutlined />} onClick={() => setAppliedText(aqlText)} disabled={aqlText === appliedText}>
            Apply
          </Button>
          <Button
            icon={<UnorderedListOutlined />}
            onClick={() => {
              setAqlMode(false);
              setAppliedText("");
              setAqlText("");
            }}
          >
            Back to conditions
          </Button>
          <Typography.Text type="secondary">
            Launch AQL: <code>tag</code>, <code>ev["variable"]</code>, <code>name</code>, <code>createdBy</code>, <code>createdDate</code>, <code>closed</code>, <code>and</code>,{" "}
            <code>or</code>, <code>not</code>, brackets.
          </Typography.Text>
        </Space>
      </Space>
    );
  }

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {conditions.map((c, i) => {
        const ops = OPERATORS.filter((o) => c.field.kind === "tag" || o.env);
        return (
          <div key={c.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {i === 0 ? (
              <Typography.Text style={{ width: 80, flex: "none", textAlign: "right" }}>Where</Typography.Text>
            ) : (
              <Select<Join>
                value={c.join}
                onChange={(join) => update(c.key, { join })}
                options={[
                  { value: "and", label: "AND" },
                  { value: "or", label: "OR" },
                ]}
                style={{ width: 80, flex: "none" }}
              />
            )}
            <FieldSelect
              value={c.field}
              onChange={(field) =>
                update(c.key, { field, values: [], op: field.kind === "env" && c.op === "contains" ? "is" : c.op })
              }
            />
            <Select<Operator>
              value={c.op}
              onChange={(op) => update(c.key, { op, values: operatorValues(op) === 1 ? c.values.slice(0, 1) : operatorValues(op) === 0 ? [] : c.values })}
              options={ops.map((o) => ({ value: o.value, label: o.label }))}
              style={{ width: 120, flex: "none" }}
              popupMatchSelectWidth={140}
            />
            {operatorValues(c.op) !== 0 && projectId && <ValueSelect projectId={projectId} condition={c} onChange={(values) => update(c.key, { values })} />}
            <Tooltip title="Remove the condition">
              <Button type="text" icon={<CloseOutlined />} onClick={() => setConditions((list) => list.filter((x) => x.key !== c.key))} />
            </Tooltip>
          </div>
        );
      })}
      <Space wrap>
        <Button icon={<PlusOutlined />} onClick={() => setConditions((list) => [...list, newCondition()])}>
          Add condition
        </Button>
        <Button
          icon={<EditOutlined />}
          onClick={() => {
            setAqlText(built);
            setAppliedText(built);
            setAqlMode(true);
          }}
        >
          Edit as AQL
        </Button>
        {conditions.length > 1 && <Typography.Text type="secondary">AND is applied before OR, as in AQL.</Typography.Text>}
      </Space>
      {built && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          AQL: <code>{built}</code>
        </Typography.Text>
      )}
    </Space>
  );
}
