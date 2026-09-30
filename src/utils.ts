import type { DiffToken, FieldRecord, SignItem, TermBinding } from "./types";

export function estimatedLines(text: string, width: number, fontSize: number, lineHeight = 1.25) {
  if (!text.trim()) return [];
  const usable = Math.max(120, width - 48);
  const lines: string[] = [];
  for (const hardLine of text.split("\n")) {
    if (!hardLine) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const char of hardLine) {
      const charWidth = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)
        ? fontSize
        : char === " "
          ? fontSize * 0.34
          : fontSize * 0.58;
      if (current && currentWidth + charWidth > usable) {
        lines.push(current.trimEnd());
        current = char.trimStart();
        currentWidth = charWidth;
      } else {
        current += char;
        currentWidth += charWidth;
      }
    }
    if (current) lines.push(current.trimEnd());
  }
  return lines;
}

export function analyzeSign(sign: SignItem, width: number, fontSize: number) {
  const lines = estimatedLines(sign.targetText, width, fontSize);
  const lineCapacity = Math.max(1, Math.floor((width * 0.62) / (fontSize * 1.25)));
  const visible = lines.slice(0, lineCapacity);
  const overflow = lines.length > lineCapacity;
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const estimatedCharacterLimit = Math.max(12, Math.floor((width - 48) / (fontSize * 0.55)) * lineCapacity);
  const tooLong = sign.targetText.replace(/\s/g, "").length > estimatedCharacterLimit;
  const missingTerms = sign.terms.filter(
    (term) => term.required && !sign.targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase()),
  );
  return {
    lines,
    visible,
    overflow,
    tooLong,
    missingTerms,
    risk: overflow || tooLong || missingTerms.length ? "high" : lines.length >= lineCapacity - 1 ? "medium" : "low",
  };
}

function tokenize(value: string) {
  return value.match(/[\u3400-\u9fff]|[A-Za-zÀ-ÿ0-9'’\-]+|\s+|./gu) ?? [];
}

function lcsTable(left: string[], right: string[]) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export function diffText(oldText: string, newText: string): DiffToken[] {
  const left = tokenize(oldText);
  const right = tokenize(newText);
  if (left.length * right.length > 180000) {
    return [{ type: "remove", value: oldText }, { type: "add", value: newText }];
  }
  const table = lcsTable(left, right);
  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffToken["type"], value: string) => {
    const previous = tokens.at(-1);
    if (previous?.type === type) previous.value += value;
    else tokens.push({ type, value });
  };
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push("same", left[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("remove", left[i]);
      i += 1;
    } else {
      push("add", right[j]);
      j += 1;
    }
  }
  while (i < left.length) push("remove", left[i++]);
  while (j < right.length) push("add", right[j++]);
  return tokens;
}

export function cloneTerms(terms: TermBinding[]) {
  return structuredClone(terms);
}

export type FieldState = "none" | "valid" | "stale";

export function fieldRecordState(sign: SignItem): FieldState {
  const record = sign.fieldRecord;
  if (!record) return "none";
  if (record.targetTextSnapshot !== sign.targetText || record.sourceTextSnapshot !== sign.sourceText) return "stale";
  return "valid";
}

export function fieldIssuesOpen(sign: SignItem): boolean {
  const record = sign.fieldRecord;
  if (!record) return false;
  return !record.consistent || record.issues.trim().length > 0;
}

export function fieldBlocksConfirmation(sign: SignItem): boolean {
  const state = fieldRecordState(sign);
  if (state === "stale") return true;
  return state === "valid" && fieldIssuesOpen(sign);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function formatRecordedAt(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function buildFieldRecordText(records: Array<Pick<FieldRecord, "code" | "consistent" | "measuredWidth" | "issues" | "recordedAt">>) {
  return records.map((record) => {
    const width = record.measuredWidth == null ? "未量到" : `${record.measuredWidth} px`;
    return [
      "【现场核对记录】",
      `标识编号：${record.code}`,
      `实物与稿子：${record.consistent ? "一致" : "不一致"}`,
      `可用宽度：${width}`,
      `具体问题：${record.issues.trim() || "无"}`,
      `记录时间：${formatRecordedAt(record.recordedAt)}`,
    ].join("\n");
  }).join("\n\n");
}

export interface ParsedFieldBlock {
  ok: boolean;
  code: string;
  consistent: boolean | null;
  measuredWidth: number | null;
  issues: string;
  recordedAt: string;
  reason?: string;
  raw: string;
}

function parseFieldBlock(raw: string): ParsedFieldBlock {
  const codeMatch = raw.match(/(?:标识编号|编号)\s*[:：]\s*([^\n\r]*?)\s*$/m);
  const code = (codeMatch?.[1] ?? "").replace(/[【】\s]/g, "").trim();
  const consistentMatch = raw.match(/实物与稿子\s*[:：]\s*([^\n\r]*)/);
  const consistentValue = consistentMatch?.[1] ?? "";
  const consistent = consistentValue.includes("不一致")
    ? false
    : consistentValue.includes("一致")
      ? true
      : null;
  const widthMatch = raw.match(/可用宽度\s*[:：]\s*([^\n\r]*)/);
  const widthValue = widthMatch?.[1] ?? "";
  const widthNumber = widthValue.match(/-?\d+(?:\.\d+)?/);
  const widthBlank = /无|没有|未量|未测|^[-—–\s]*$/.test(widthValue);
  const measuredWidth = widthNumber ? Number(widthNumber[0]) : null;
  const widthReadable = Boolean(widthNumber) || widthBlank;
  const issuesMatch = raw.match(/具体问题\s*[:：]\s*([^\n\r]*)/);
  const issuesRaw = (issuesMatch?.[1] ?? "").trim();
  const issues = /^(无|没有|没|未|[-—–\s]*)$/.test(issuesRaw) ? "" : issuesRaw;
  const recordedAtMatch = raw.match(/记录时间\s*[:：]\s*([^\n\r]*)/);
  const recordedAt = (recordedAtMatch?.[1] ?? "").trim() || new Date().toISOString();

  if (!code) return { ok: false, code: "", consistent: null, measuredWidth: null, issues: "", recordedAt: "", reason: "缺少标识编号", raw };
  if (consistent === null) return { ok: false, code, consistent: null, measuredWidth: null, issues: "", recordedAt: "", reason: "无法判断实物与稿子是否一致", raw };
  if (!widthReadable) return { ok: false, code, consistent, measuredWidth: null, issues, recordedAt, reason: "可用宽度读不了", raw };
  return { ok: true, code, consistent, measuredWidth, issues, recordedAt, raw };
}

function parseFieldJson(text: string): ParsedFieldBlock[] {
  const data = JSON.parse(text) as unknown;
  const items = Array.isArray(data) ? data : [data];
  return items.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const code = String(record.code ?? record.标识编号 ?? record.id ?? "").trim();
    const consistentRaw = record.consistent ?? record["实物与稿子"];
    const consistent = typeof consistentRaw === "boolean"
      ? consistentRaw
      : String(consistentRaw ?? "").includes("不一致")
        ? false
        : String(consistentRaw ?? "").includes("一致")
          ? true
          : null;
    let measuredWidth: number | null = null;
    let widthReadable = true;
    if (record.measuredWidth != null && record.measuredWidth !== "") {
      const number = Number(record.measuredWidth);
      if (Number.isFinite(number)) measuredWidth = number;
      else widthReadable = false;
    }
    const issuesRaw = String(record.issues ?? record["具体问题"] ?? "").trim();
    const issues = /^(无|没有|没|未|[-—–\s]*)$/.test(issuesRaw) ? "" : issuesRaw;
    const recordedAt = String(record.recordedAt ?? record["记录时间"] ?? new Date().toISOString());
    const raw = JSON.stringify(item);
    if (!code) return { ok: false, code: "", consistent: null, measuredWidth: null, issues: "", recordedAt: "", reason: "缺少标识编号", raw };
    if (consistent === null) return { ok: false, code, consistent: null, measuredWidth: null, issues: "", recordedAt: "", reason: "无法判断实物与稿子是否一致", raw };
    if (!widthReadable) return { ok: false, code, consistent, measuredWidth: null, issues, recordedAt, reason: "可用宽度读不了", raw };
    return { ok: true, code, consistent, measuredWidth, issues, recordedAt, raw };
  });
}

export function parseFieldRecords(text: string): ParsedFieldBlock[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseFieldJson(trimmed);
    } catch {
      return [{ ok: false, code: "", consistent: null, measuredWidth: null, issues: "", recordedAt: "", reason: "内容读不了", raw: trimmed }];
    }
  }
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (/^\s*(标识编号|编号)\s*[:：]/.test(line)) {
      if (current.length) blocks.push(current.join("\n"));
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  if (!blocks.length) return [{ ok: false, code: "", consistent: null, measuredWidth: null, issues: "", recordedAt: "", reason: "未找到标识编号", raw: trimmed }];
  return blocks.map(parseFieldBlock);
}
