export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

export type InspectionMatch = "consistent" | "mismatch";

/** 巡检员在现场核对后、导回校对台的一条结论（挂在标识编号上）。 */
export interface FieldInspection {
  id: string;
  code: string;
  inspector: string;
  /** 实物与稿子是否一致。 */
  match: InspectionMatch;
  /** 现场量到的标识可用宽度，单位毫米。 */
  usableWidthMm: number;
  /** 具体问题；一致时记“无”。 */
  issue: string;
  issueHandled: boolean;
  /** 巡检员在现场保存记录的时间。 */
  inspectedAt: string;
  /** 记录导回校对台的时间。 */
  importedAt: string;
  /** 记录那一刻稿子的原文/译文快照，用于事后判断结论是否随改稿失效。 */
  sourceSnapshot: string;
  targetSnapshot: string;
  /** 导入用的原始文本，便于追溯。 */
  raw: string;
}

/** 巡检设备（只读预览页）上未导回的本机草稿。 */
export interface FieldDraft {
  signId: string;
  code: string;
  inspector: string;
  match: "" | InspectionMatch;
  width: string;
  issue: string;
  inspectedAt: string;
  savedAt: string;
  src: string;
  tgt: string;
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  fieldInspection?: FieldInspection;
  emergencyRevision: boolean;
  updatedAt: string;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 1;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
