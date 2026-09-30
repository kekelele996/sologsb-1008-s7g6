import type { FieldDraft, FieldInspection, InspectionMatch, SignItem } from "./types";
import { uid } from "./data";

export const FIELD_DRAFT_STORAGE_KEY = "sologsb-1008-field-drafts-v1";
export const FIELD_FAILED_STORAGE_KEY = "sologsb-1008-field-failed-v1";
export const FIELD_INSPECTOR_KEY = "sologsb-1008-field-inspector";
export const FIELD_PAYLOAD_MARKER = "FIELD-CHECKS-V1";

/** 导不进来、要原样留着等重试的记录。 */
export interface FailedFieldEntry {
  id: string;
  raw: string;
  reason: string;
  failedAt: string;
}

export interface ImportedFieldRecord {
  record: Omit<FieldInspection, "importedAt">;
  raw: string;
}

export interface FieldImportResult {
  imported: ImportedFieldRecord[];
  failed: FailedFieldEntry[];
}

interface DecodedDraft {
  code: string;
  match: InspectionMatch;
  width: number;
  issue: string;
  inspectedAt: string;
  inspector: string;
  src: string;
  tgt: string;
}

/** 草稿字段齐全才算一条可导出的现场记录。 */
export function isDraftComplete(draft: FieldDraft | undefined): draft is FieldDraft {
  if (!draft || !draft.match || !draft.inspectedAt) return false;
  const width = Number(draft.width);
  if (!Number.isFinite(width) || width <= 0) return false;
  if (draft.match === "mismatch" && !draft.issue.trim()) return false;
  return true;
}

/** 现场结论所依据的稿子已经被改动（原文或译文任一变化即失效）。 */
export function isInspectionStale(sign: SignItem): boolean {
  const inspection = sign.fieldInspection;
  if (!inspection) return false;
  return inspection.sourceSnapshot !== sign.sourceText || inspection.targetSnapshot !== sign.targetText;
}

/** 还有没处理的现场问题：不一致且问题未标记处理。 */
export function hasOpenFieldIssue(sign: SignItem): boolean {
  const inspection = sign.fieldInspection;
  return Boolean(inspection && inspection.match === "mismatch" && !inspection.issueHandled);
}

/** 有未处理的现场问题，或现场结论已随改稿失效，都不能点成已确认。 */
export function signConfirmBlocked(sign: SignItem): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (hasOpenFieldIssue(sign)) reasons.push("存在未处理的现场问题");
  if (isInspectionStale(sign)) reasons.push("现场结论依据的稿子已改动，需重新确认");
  return { blocked: reasons.length > 0, reasons };
}

function parseWidth(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value * 10) / 10;
  if (typeof value !== "string") throw new Error("可用宽度读不了");
  const matched = value.match(/-?\d+(\.\d+)?/);
  if (!matched) throw new Error("可用宽度读不了");
  const width = Number(matched[0]);
  if (!Number.isFinite(width) || width <= 0) throw new Error("可用宽度必须大于 0");
  return Math.round(width * 10) / 10;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function decodeLine(obj: Record<string, unknown>): DecodedDraft {
  const code = asString(obj.code ?? obj.c).trim();
  if (!code) throw new Error("编号读不了");

  const matchRaw = asString(obj.match ?? obj.m).trim();
  let match: InspectionMatch;
  if (/^(一致|consistent|ok|true|1)$/i.test(matchRaw)) match = "consistent";
  else if (/^(不一致|mismatch|diff|false|0)$/i.test(matchRaw)) match = "mismatch";
  else throw new Error("是否一致读不了");

  const width = parseWidth(obj.width ?? obj.w);
  const issue = asString(obj.issue ?? obj.i).trim();
  if (match === "mismatch" && !issue) throw new Error("不一致但没写具体问题");

  const inspectedAt = asString(obj.at ?? obj.time ?? "").trim() || new Date().toISOString();
  if (Number.isNaN(Date.parse(inspectedAt))) throw new Error("现场时间读不了");

  return {
    code,
    match,
    width,
    issue: issue || "无",
    inspectedAt,
    inspector: asString(obj.inspector ?? obj.by ?? "").trim() || "现场巡检员",
    src: asString(obj.src ?? obj.s),
    tgt: asString(obj.tgt ?? obj.t),
  };
}

/**
 * 解析巡检员从现场带回来的文本：每行一条 JSON，同一编号后出现的覆盖前面的。
 * 解析/内容校验失败的条目随原文返回，调用方原样保留，供重试。
 */
export function parseFieldPayload(payload: string): FieldImportResult {
  const imported: ImportedFieldRecord[] = [];
  const failed: FailedFieldEntry[] = [];
  const now = new Date().toISOString();

  for (const rawLine of payload.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith("#")) continue;
    if (raw.startsWith(FIELD_PAYLOAD_MARKER)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      failed.push({ id: uid("fail"), raw, reason: "内容读不了（不是有效记录格式）", failedAt: now });
      continue;
    }
    if (typeof obj !== "object" || obj === null) {
      failed.push({ id: uid("fail"), raw, reason: "内容读不了", failedAt: now });
      continue;
    }
    try {
      const decoded = decodeLine(obj as Record<string, unknown>);
      imported.push({
        record: {
          id: uid("insp"),
          code: decoded.code,
          inspector: decoded.inspector,
          match: decoded.match,
          usableWidthMm: decoded.width,
          issue: decoded.issue,
          issueHandled: false,
          inspectedAt: decoded.inspectedAt,
          sourceSnapshot: decoded.src,
          targetSnapshot: decoded.tgt,
          raw,
        },
        raw,
      });
    } catch (error) {
      failed.push({
        id: uid("fail"),
        raw,
        reason: error instanceof Error ? error.message : "内容读不了",
        failedAt: now,
      });
    }
  }

  // 同一段文本里同一编号出现多次时，以最后一条为准。
  const byCode = new Map<string, ImportedFieldRecord>();
  for (const item of imported) byCode.set(item.record.code, item);
  return { imported: [...byCode.values()], failed };
}

/** 把一条本机草稿编码成可粘贴的记录行。 */
export function encodeFieldDraft(draft: FieldDraft): string {
  return JSON.stringify({
    code: draft.code,
    match: draft.match,
    width: draft.width.trim(),
    issue: draft.issue.trim(),
    at: draft.inspectedAt,
    by: draft.inspector.trim() || "现场巡检员",
    src: draft.src,
    tgt: draft.tgt,
  });
}

export function buildFieldPayload(drafts: FieldDraft[]): string {
  const complete = drafts.filter(isDraftComplete);
  const lines = complete.map(encodeFieldDraft);
  return [`# ${FIELD_PAYLOAD_MARKER} · 现场核对记录 ${complete.length} 条`, ...lines].join("\n");
}

export function readFailedEntries(): FailedFieldEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FIELD_FAILED_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as FailedFieldEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeFailedEntries(entries: FailedFieldEntry[]) {
  localStorage.setItem(FIELD_FAILED_STORAGE_KEY, JSON.stringify(entries));
}
