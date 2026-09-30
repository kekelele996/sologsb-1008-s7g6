import { $, component$, useSignal, useVisibleTask$, type QRL } from "@builder.io/qwik";
import { type DocumentHead } from "@builder.io/qwik-city";
import { createSeedProject, STATUS_LABELS, uid } from "../data";
import type { FieldDraft, ReviewStatus, SignItem, SignProject } from "../types";
import { analyzeSign, cloneTerms, diffText } from "../utils";
import {
  buildFieldPayload,
  FIELD_DRAFT_STORAGE_KEY,
  FIELD_INSPECTOR_KEY,
  FIELD_PAYLOAD_MARKER,
  isDraftComplete,
  parseFieldPayload,
  readFailedEntries,
  signConfirmBlocked,
  writeFailedEntries,
  type FailedFieldEntry,
} from "../field";

const STORAGE_KEY = "sologsb-1008-project-v1";
const WIDTHS = [320, 480, 720, 960] as const;

export const head: DocumentHead = {
  title: "公共标识多语言校对台",
  meta: [
    { name: "description", content: "公共标识译文、术语、版本和版面风险校对工作台" },
  ],
};

function statusClass(status: ReviewStatus) {
  if (status === "confirmed") return "badge-success";
  if (status === "changes") return "badge-error";
  if (status === "pending") return "badge-warning";
  return "badge-neutral";
}

export default component$(() => {
  const project = useSignal<SignProject>(createSeedProject());
  const past = useSignal<SignProject[]>([]);
  const future = useSignal<SignProject[]>([]);
  const hydrated = useSignal(false);
  const online = useSignal(true);
  const previewWidth = useSignal(480);
  const previewFont = useSignal(42);
  const selectedVersionId = useSignal("");
  const termSource = useSignal("");
  const termTarget = useSignal("");
  const commentDraft = useSignal("");
  const replyDraft = useSignal("");
  const replyingTo = useSignal("");
  const toast = useSignal("");
  const previewId = useSignal("");
  const readOnly = useSignal(false);
  const previewSignId = useSignal("");
  // 巡检设备上的本机现场记录
  const fieldDrafts = useSignal<Record<string, FieldDraft>>({});
  const inspectorName = useSignal("");
  // 校对台导入区
  const fieldPayload = useSignal("");
  const importNotice = useSignal("");
  const failedEntries = useSignal<FailedFieldEntry[]>([]);
  const active = () => project.value.signs.find((sign) => sign.id === (previewId.value || project.value.activeSignId)) ?? project.value.signs[0];

  const commit = $((label: string, update: (draft: SignProject) => void) => {
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = [];
    const draft = structuredClone(project.value);
    update(draft);
    draft.updatedAt = new Date().toISOString();
    project.value = draft;
  });

  const updateActive = $((label: string, update: (sign: SignItem, draft: SignProject) => void) => {
    commit(label, (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (sign) update(sign, draft);
    });
  });

  const undo = $(() => {
    if (!past.value.length) return;
    const previous = past.value.at(-1)!;
    future.value = [structuredClone(project.value), ...future.value].slice(0, 50);
    past.value = past.value.slice(0, -1);
    project.value = previous;
    toast.value = "已撤销";
  });

  const redo = $(() => {
    if (!future.value.length) return;
    const next = future.value[0];
    past.value = [...past.value.slice(-49), structuredClone(project.value)];
    future.value = future.value.slice(1);
    project.value = next;
    toast.value = "已重做";
  });

  const navigateSign = $((direction: 1 | -1) => {
    if (readOnly.value) return;
    const signs = project.value.signs;
    const index = Math.max(0, signs.findIndex((sign) => sign.id === project.value.activeSignId));
    const next = signs[(index + direction + signs.length) % signs.length];
    commit("切换标识", (draft) => { draft.activeSignId = next.id; });
    selectedVersionId.value = "";
  });

  const setStatus = $((status: ReviewStatus) => {
    const current = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (current && status === "confirmed") {
      const { blocked, reasons } = signConfirmBlocked(current);
      if (blocked) {
        toast.value = `不能标记为已确认：${reasons.join("；")}`;
        return;
      }
    }
    commit("更新审校状态", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      if (sign.emergencyRevision && status === "confirmed") {
        sign.status = "pending";
      } else {
        sign.status = status;
      }
    });
  });

  const toggleEmergency = $(() => {
    commit("切换紧急修订", (draft) => {
      const sign = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!sign) return;
      sign.emergencyRevision = !sign.emergencyRevision;
      if (sign.emergencyRevision) sign.status = "changes";
    });
  });

  const saveVersion = $(() => {
    const sign = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!sign) return;
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      const current = draft.signs.find((item) => item.id === draft.activeSignId);
      if (!current) return;
      current.versions.unshift({
        id: versionId,
        label: `版本 ${current.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        sourceText: current.sourceText,
        targetText: current.targetText,
        status: current.status,
        terms: cloneTerms(current.terms),
      });
      current.versions = current.versions.slice(0, 12);
    });
    selectedVersionId.value = versionId;
    toast.value = "版本快照已保存";
  });

  const addTerm = $(() => {
    const source = termSource.value.trim();
    const target = termTarget.value.trim();
    if (!source || !target) return;
    updateActive("绑定术语", (sign) => {
      sign.terms.push({ id: uid("term"), source, target, required: true, confirmed: false });
      sign.status = "pending";
    });
    termSource.value = "";
    termTarget.value = "";
  });

  const addComment = $(() => {
    const body = commentDraft.value.trim();
    if (!body) return;
    updateActive("添加审校意见", (sign) => {
      sign.comments.unshift({
        id: uid("comment"),
        author: "当前审校员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      sign.status = sign.status === "confirmed" ? "changes" : sign.status;
    });
    commentDraft.value = "";
  });

  const addReply = $((commentId: string) => {
    const body = replyDraft.value.trim();
    if (!body) return;
    updateActive("回复审校意见", (sign) => {
      const comment = sign.comments.find((item) => item.id === commentId);
      comment?.replies.push({ id: uid("reply"), author: "当前审校员", body, createdAt: new Date().toISOString() });
    });
    replyDraft.value = "";
    replyingTo.value = "";
  });

  const sharePreview: QRL<() => void> = $(() => {
    const current = project.value.signs.find((item) => item.id === project.value.activeSignId);
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?preview=${encodeURIComponent(current.id)}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.value = "只读预览链接已复制";
  });

  // ---------- 只读预览页：现场逐条核对，先记在本机 ----------
  const activePreviewSign = () =>
    project.value.signs.find((sign) => sign.id === previewSignId.value) ??
    project.value.signs.find((sign) => sign.id === previewId.value) ??
    project.value.signs[0];

  const previewDrafts = () =>
    project.value.signs.map((sign) => fieldDrafts.value[sign.id]).filter(isDraftComplete);

  const patchDraft = $((patch: Partial<FieldDraft>) => {
    const sign = activePreviewSign();
    if (!sign) return;
    const existing = fieldDrafts.value[sign.id];
    const now = new Date().toISOString();
    const base: FieldDraft = existing ?? {
      signId: sign.id,
      code: sign.code,
      inspector: inspectorName.value,
      match: "",
      width: "",
      issue: "",
      inspectedAt: "",
      savedAt: now,
      src: sign.sourceText,
      tgt: sign.targetText,
    };
    const next: FieldDraft = { ...base, ...patch, signId: sign.id, savedAt: now };
    // 记录一旦完整定格，编号与稿子快照也随之固定；之后改号不再漂移，导入时如实报“编号对不上”。
    if (!existing?.inspectedAt) next.code = sign.code;
    const widthOk = Number.isFinite(Number(next.width)) && Number(next.width) > 0;
    // 第一次把结论填完整时，定格现场时间和当时稿子的快照。
    if (!existing?.inspectedAt && next.match && widthOk && (next.match === "consistent" || next.issue.trim())) {
      next.inspectedAt = now;
      next.src = sign.sourceText;
      next.tgt = sign.targetText;
    }
    fieldDrafts.value = { ...fieldDrafts.value, [sign.id]: next };
  });

  const clearDraft = $(() => {
    const sign = activePreviewSign();
    if (!sign) return;
    const next = { ...fieldDrafts.value };
    delete next[sign.id];
    fieldDrafts.value = next;
  });

  const updateInspector = $((name: string) => {
    inspectorName.value = name;
    try {
      localStorage.setItem(FIELD_INSPECTOR_KEY, name);
    } catch {
      // 私密模式等情况下写不进就算了，不影响本次记录。
    }
  });

  const fieldExportText = () => buildFieldPayload(previewDrafts());

  const copyFieldExport = $(async () => {
    const count = previewDrafts().length;
    if (!count) {
      toast.value = "还没有完整的现场记录";
      return;
    }
    try {
      await navigator.clipboard.writeText(fieldExportText());
      toast.value = `已复制 ${count} 条现场记录，回工位粘贴到校对台导入`;
    } catch {
      toast.value = "复制失败，请点“下载记录”或手动全选复制";
    }
  });

  const downloadFieldExport = $(() => {
    const count = previewDrafts().length;
    if (!count) {
      toast.value = "还没有完整的现场记录";
      return;
    }
    const blob = new Blob([fieldExportText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `field-checks-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    toast.value = `已导出 ${count} 条现场记录`;
  });

  // ---------- 校对台：粘贴现场记录按编号对账 ----------
  const runImport = $((rawText: string, retryingIds: string[] = []) => {
    const result = parseFieldPayload(rawText);
    const now = new Date().toISOString();

    // 本次解析失败的 + 编号找不到的，统一按原文去重。
    const newFailures: FailedFieldEntry[] = [...result.failed];
    for (const item of result.imported) {
      const exists = project.value.signs.some((entry) => entry.code.trim() === item.record.code.trim());
      if (!exists) {
        newFailures.push({
          id: uid("fail"),
          raw: item.raw,
          reason: `编号 ${item.record.code} 在工作台里找不到对应标识`,
          failedAt: now,
        });
      }
    }
    const newFailureByRaw = new Map(newFailures.map((entry) => [entry.raw, entry]));

    const matchedCodes = new Set(
      result.imported
        .filter((item) => !newFailureByRaw.has(item.raw))
        .map((item) => item.record.code.trim()),
    );

    if (matchedCodes.size) {
      commit("导回现场核对记录", (draft) => {
        for (const item of result.imported) {
          if (newFailureByRaw.has(item.raw)) continue;
          const sign = draft.signs.find((entry) => entry.code.trim() === item.record.code.trim());
          if (!sign) continue;
          sign.fieldInspection = { ...item.record, importedAt: now };
          // 有未处理的现场问题时不能停在已确认；失效结论强制回到待确认。
          const stale =
            item.record.sourceSnapshot !== sign.sourceText || item.record.targetSnapshot !== sign.targetText;
          if (stale || (sign.fieldInspection.match === "mismatch" && !sign.fieldInspection.issueHandled)) {
            if (sign.status === "confirmed") sign.status = stale ? "pending" : "changes";
          }
        }
      });
    }

    // 重试成功（不在新失败里）的旧条目移除；其余旧条目保留；新旧都失败的更新原因与时间。
    const keptPrevious = failedEntries.value.filter(
      (entry) => !retryingIds.includes(entry.id) || newFailureByRaw.has(entry.raw),
    );
    const merged: FailedFieldEntry[] = [];
    const seen = new Set<string>();
    for (const failure of [...newFailures, ...keptPrevious]) {
      if (seen.has(failure.raw)) continue;
      seen.add(failure.raw);
      merged.push(failure);
    }
    failedEntries.value = merged;
    try {
      writeFailedEntries(merged);
    } catch {
      // 失败清单存不下时仍保留在内存里，不影响已导入的数据。
    }

    const parts: string[] = [`成功 ${matchedCodes.size} 条`];
    if (newFailures.length) parts.push(`失败 ${newFailures.length} 条，已原样保留`);
    importNotice.value = parts.join("，");
    if (!matchedCodes.size && !newFailures.length) importNotice.value = "没有识别到可导入的现场记录";
    fieldPayload.value = "";
  });

  const importFromBox = $(() => {
    const text = fieldPayload.value.trim();
    if (!text) {
      importNotice.value = "请先粘贴现场记录";
      return;
    }
    runImport(text);
  });

  const retryEntry = $((entry: FailedFieldEntry) => {
    runImport(entry.raw, [entry.id]);
  });

  const retryAllFailed = $(() => {
    if (!failedEntries.value.length) return;
    const ids = failedEntries.value.map((entry) => entry.id);
    runImport(failedEntries.value.map((entry) => entry.raw).join("\n"), ids);
  });

  const removeFailedEntry = $((entry: FailedFieldEntry) => {
    const next = failedEntries.value.filter((item) => item.id !== entry.id);
    failedEntries.value = next;
    try {
      writeFailedEntries(next);
    } catch {
      // ignore
    }
  });

  const toggleIssueHandled = $((signId: string) => {
    commit("更新现场问题处理状态", (draft) => {
      const sign = draft.signs.find((item) => item.id === signId);
      if (sign?.fieldInspection) sign.fieldInspection.issueHandled = !sign.fieldInspection.issueHandled;
    });
  });

  const preview = () => analyzeSign(active(), previewWidth.value, previewFont.value);
  const selectedVersion = () => active().versions.find((version) => version.id === selectedVersionId.value) ?? active().versions[0];
  const comparison = () => {
    const version = selectedVersion();
    return version ? diffText(version.targetText, active().targetText) : [];
  };

  useVisibleTask$(({ track }) => {
    track(() => hydrated.value);
    if (!hydrated.value) {
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as { schema: number; project: SignProject };
        if (stored.schema === 1 && stored.project?.signs?.length) project.value = stored.project;
        const requestedPreview = new URLSearchParams(window.location.search).get("preview") ?? "";
        previewId.value = requestedPreview;
        readOnly.value = Boolean(requestedPreview);
        previewSignId.value = requestedPreview;
      } catch {
        // Keep bundled sample data when storage is unavailable or malformed.
      }
      try {
        const drafts = JSON.parse(localStorage.getItem(FIELD_DRAFT_STORAGE_KEY) ?? "{}");
        if (drafts && typeof drafts === "object") fieldDrafts.value = drafts as Record<string, FieldDraft>;
      } catch {
        // 草稿坏了就从空开始，不影响预览。
      }
      try {
        inspectorName.value = localStorage.getItem(FIELD_INSPECTOR_KEY) ?? "";
      } catch {
        // ignore
      }
      failedEntries.value = readFailedEntries();
      hydrated.value = true;
    }
  });

  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value || !readOnly.value) return;
    track(() => fieldDrafts.value);
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(FIELD_DRAFT_STORAGE_KEY, JSON.stringify(fieldDrafts.value));
      } catch {
        // 空间不足时保留内存中的记录，本次巡检仍可继续。
      }
    }, 200);
    cleanup(() => window.clearTimeout(timer));
  });

  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value) return;
    track(() => project.value);
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 1, project: project.value }));
    }, 450);
    cleanup(() => window.clearTimeout(timer));
  });

  useVisibleTask$(({ cleanup }) => {
    const updateOnline = () => { online.value = navigator.onLine; };
    updateOnline();
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? undo() : undo();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (readOnly.value) {
          const signs = project.value.signs;
          const index = signs.findIndex((sign) => sign.id === previewSignId.value);
          previewSignId.value = signs[(index + 1 + signs.length) % signs.length].id;
        } else {
          navigateSign(1);
        }
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (readOnly.value) {
          const signs = project.value.signs;
          const index = signs.findIndex((sign) => sign.id === previewSignId.value);
          previewSignId.value = signs[(index - 1 + signs.length) % signs.length].id;
        } else {
          navigateSign(-1);
        }
      } else if (event.key === "[") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.max(0, index - 1)];
      } else if (event.key === "]") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.min(WIDTHS.length - 1, index + 1)];
      } else if (event.key === "-") {
        previewFont.value = Math.max(28, previewFont.value - 4);
      } else if (event.key === "=") {
        previewFont.value = Math.min(88, previewFont.value + 4);
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("keydown", keydown);
    cleanup(() => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("keydown", keydown);
    });
  });

  if (readOnly.value) {
    const signs = project.value.signs;
    const sign = activePreviewSign();
    const index = signs.findIndex((item) => item.id === sign.id);
    const analysis = analyzeSign(sign, previewWidth.value, previewFont.value);
    const draft = fieldDrafts.value[sign.id];
    const completeDrafts = previewDrafts();
    const hasDraft = isDraftComplete(draft);
    const go = (offset: number) => {
      previewSignId.value = signs[(index + offset + signs.length) % signs.length].id;
    };
    return (
      <main data-theme="corporate" class="min-h-screen bg-slate-100 p-4 sm:p-6">
        <div class="mx-auto max-w-5xl space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-3 shadow-sm">
            <div>
              <div class="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Read-only preview · 现场核对</div>
              <h1 class="text-lg font-bold text-slate-800">{project.value.title}</h1>
            </div>
            <div class="flex items-center gap-2">
              <span class={`badge badge-sm ${online.value ? "badge-success" : "badge-warning"}`}>{online.value ? "在线" : "离线·已存本机"}</span>
              <span class="badge badge-sm badge-outline">{completeDrafts.length}/{signs.length} 已核对</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="join">
              <button class="btn btn-sm join-item btn-outline" onClick$={() => go(-1)}>‹ 上一条 <kbd class="kbd kbd-xs ml-1">K</kbd></button>
              <button class="btn btn-sm join-item btn-outline" onClick$={() => go(1)}><kbd class="kbd kbd-xs mr-1">J</kbd> 下一条 ›</button>
            </div>
            <div class="join">
              <button class="btn btn-sm join-item btn-primary" disabled={!completeDrafts.length} onClick$={copyFieldExport}>复制现场记录</button>
              <button class="btn btn-sm join-item btn-outline" disabled={!completeDrafts.length} onClick$={downloadFieldExport}>下载记录</button>
            </div>
          </div>

          <div class="flex flex-wrap gap-1">
            {signs.map((item, itemIndex) => {
              const done = isDraftComplete(fieldDrafts.value[item.id]);
              const mismatch = fieldDrafts.value[item.id]?.match === "mismatch";
              return (
                <button
                  key={item.id}
                  title={`${item.code} ${item.sourceText.slice(0, 12)}`}
                  class={`badge badge-sm gap-1 font-mono ${item.id === sign.id ? "badge-lg badge-primary" : mismatch ? "badge-error" : done ? "badge-success" : "badge-ghost"}`}
                  onClick$={() => { previewSignId.value = item.id; }}
                >
                  {itemIndex + 1}. {item.code}{mismatch ? " !" : done ? " ✓" : ""}
                </button>
              );
            })}
          </div>

          <div class="flex items-center justify-between">
            <h2 class="text-2xl font-bold text-slate-800">{sign.code} · {sign.scenario}</h2>
            <span class={`badge ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
          </div>
          {draft?.inspectedAt && draft.code !== sign.code && (
            <div class="alert alert-warning py-2 text-xs">
              这条记录当时的编号是 {draft.code}，当前稿子编号已是 {sign.code}；导回时会按 {draft.code} 对账，若对不上会留在失败区。
            </div>
          )}
          <section class="rounded-3xl bg-white p-10 shadow-xl sm:p-14">
            <div class="mb-3 text-center text-xs text-slate-400">中文原文（稿子）</div>
            <p class="mx-auto mb-8 max-w-2xl text-center text-base text-slate-600 sm:text-lg">{sign.sourceText}</p>
            <div class="mx-auto border-y-4 border-slate-800 py-10 text-center">
              <p class="whitespace-pre-line font-black leading-tight tracking-wide text-slate-900" style={{ fontSize: `${previewFont.value}px` }}>{analysis.visible.join("\n")}</p>
            </div>
            <div class="mt-5 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-500">
              <span>{sign.targetLanguage} · {sign.regulation}</span>
            </div>
            <div class="mt-6 flex flex-wrap items-center justify-center gap-1">
              {WIDTHS.map((width) => <button key={width} class={`btn btn-xs ${previewWidth.value === width ? "btn-primary" : "btn-outline"}`} onClick$={() => previewWidth.value = width}>{width}px</button>)}
            </div>
          </section>

          <section class="rounded-2xl border-2 border-blue-200 bg-white p-5 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="font-bold text-slate-800">现场核对</h3>
                <p class="text-xs text-slate-500">对着实物逐条填写；没有网络也会先存到这台设备，回工位再导回校对台。</p>
              </div>
              <span class={`badge ${hasDraft ? "badge-success" : "badge-ghost"}`}>{hasDraft ? "本机已记录" : "待核对"}</span>
            </div>

            <label class="form-control mt-4 max-w-xs">
              <span class="label-text mb-1 text-xs font-bold text-slate-500">巡检员</span>
              <input class="input input-sm input-bordered" placeholder="姓名或工号" value={inspectorName.value} onInput$={(_, el) => updateInspector(el.value)} />
            </label>

            <div class="mt-4">
              <span class="label-text mb-1 block text-xs font-bold text-slate-500">实物与稿子是否一致</span>
              <div class="join">
                {([["consistent", "一致"], ["mismatch", "不一致"]] as const).map(([value, label]) => (
                  <button
                    key={value}
                    class={`btn join-item btn-sm ${draft?.match === value ? value === "consistent" ? "btn-success" : "btn-error" : "btn-outline"}`}
                    onClick$={() => patchDraft({ match: value, inspector: inspectorName.value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <label class="form-control mt-4 max-w-xs">
              <span class="label-text mb-1 text-xs font-bold text-slate-500">现场量到的可用宽度（毫米 mm）</span>
              <input
                type="number"
                min="1"
                inputMode="decimal"
                class="input input-sm input-bordered"
                placeholder="例如 620"
                value={draft?.width ?? ""}
                onInput$={(_, el) => patchDraft({ width: el.value, inspector: inspectorName.value })}
              />
            </label>

            <label class="form-control mt-4">
              <span class="label-text mb-1 text-xs font-bold text-slate-500">
                具体问题{draft?.match === "mismatch" ? "（不一致时必填：缺字、错译、装错位置、版面截断…）" : "（一致可留空）"}
              </span>
              <textarea
                class="textarea textarea-bordered min-h-20 w-full text-sm leading-6"
                placeholder="写清实物和稿子差在哪、现场情况…"
                value={draft?.issue ?? ""}
                onInput$={(_, el) => patchDraft({ issue: el.value, inspector: inspectorName.value })}
              />
            </label>

            <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs text-slate-400">
                {draft?.inspectedAt ? `记录时间：${new Date(draft.inspectedAt).toLocaleString()}` : "三项填完整后自动定格记录时间"}
              </span>
              <div class="flex gap-2">
                <button class="btn btn-sm btn-ghost" disabled={!draft} onClick$={clearDraft}>清空本条</button>
                <button class="btn btn-sm btn-primary" disabled={index + 1 >= signs.length} onClick$={() => go(1)}>保存并下一条</button>
              </div>
            </div>
          </section>

          {completeDrafts.length > 0 && (
            <section class="rounded-2xl bg-white p-5 shadow-sm">
              <div class="flex items-center justify-between">
                <h3 class="font-bold text-slate-800">本机现场记录</h3>
                <span class="text-xs text-slate-400">仅保存在本设备浏览器，不会上传</span>
              </div>
              <ul class="mt-3 space-y-2">
                {signs.map((item) => {
                  const itemDraft = fieldDrafts.value[item.id];
                  if (!isDraftComplete(itemDraft)) return null;
                  return (
                    <li key={item.id}>
                      <button class="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50" onClick$={() => { previewSignId.value = item.id; }}>
                        <span class="font-mono text-xs font-bold">{item.code}</span>
                        <span class={`badge badge-xs ${itemDraft.match === "consistent" ? "badge-success" : "badge-error"}`}>{itemDraft.match === "consistent" ? "一致" : "不一致"}</span>
                        <span class="text-xs text-slate-500">{itemDraft.width}mm</span>
                        <span class="min-w-0 flex-1 truncate text-xs text-slate-600">{itemDraft.issue || "无"}</span>
                        <span class="text-[11px] text-slate-400">{new Date(itemDraft.inspectedAt).toLocaleString()}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p class="mt-3 text-xs text-slate-500">回到工位后点右上角“复制现场记录”，粘贴到校对台的“现场记录导入”。</p>
            </section>
          )}

          <p class="pb-4 text-center text-xs text-slate-400">此页面为只读预览：稿子内容不可编辑；核对记录只写入当前浏览器本机存储。</p>
        </div>
      </main>
    );
  }

  return (
    <div data-theme="corporate" class="min-h-screen bg-slate-100 pb-9 text-slate-800">
      <header class="navbar sticky top-0 z-40 min-h-16 border-b border-slate-700 bg-[#17324d] px-5 text-white shadow-lg">
        <div class="navbar-start gap-3">
          <div class="grid h-10 w-10 place-items-center rounded-xl border border-white/20 bg-white/10 font-black">译</div>
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-sky-200">Public Sign Review</div>
            <div class="font-bold">公共标识多语言校对台</div>
          </div>
        </div>
        <div class="navbar-center hidden xl:flex">
          <input
            class="input input-sm w-80 border-white/15 bg-white/10 text-white placeholder:text-slate-300"
            value={project.value.title}
            onInput$={(_, element) => commit("修改项目名称", (draft) => { draft.title = element.value; })}
            aria-label="项目名称"
          />
        </div>
        <div class="navbar-end gap-2">
          <span class={`badge ${online.value ? "badge-success" : "badge-warning"} badge-outline`}>{online.value ? "在线" : "离线草稿"}</span>
          <button class="btn btn-ghost btn-sm" disabled={!past.value.length} onClick$={undo}>撤销</button>
          <button class="btn btn-ghost btn-sm" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="btn btn-sm border-white/20 bg-white/10 text-white hover:bg-white/20" onClick$={sharePreview}>复制只读链接</button>
          <button class={`btn btn-sm ${active().emergencyRevision ? "btn-error" : "btn-warning"}`} onClick$={toggleEmergency}>
            {active().emergencyRevision ? "退出紧急修订" : "紧急修订"}
          </button>
        </div>
      </header>

      {active().emergencyRevision && (
        <div class="alert alert-error sticky top-16 z-30 rounded-none border-x-0 py-2 text-white">
          <span class="text-lg">!</span>
          <span><strong>紧急修订模式</strong>：确认操作已锁定，修改后必须重新审校并保存版本。</span>
        </div>
      )}

      <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
        <aside class="overflow-y-auto bg-slate-50 p-3">
          <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">标识清单</div>
            <div class="mt-1 text-lg font-bold text-slate-800">{project.value.signs.length} 处标识</div>
            <p class="mt-1 text-xs leading-5 text-slate-500">{project.value.location}</p>
          </div>
          <div class="space-y-2">
            {project.value.signs.map((sign, index) => {
              const risk = analyzeSign(sign, previewWidth.value, previewFont.value);
              const inspection = sign.fieldInspection;
              const fieldStale = inspection
                ? inspection.sourceSnapshot !== sign.sourceText || inspection.targetSnapshot !== sign.targetText
                : false;
              const fieldOpen = inspection?.match === "mismatch" && !inspection.issueHandled;
              return (
                <button
                  key={sign.id}
                  class={`w-full rounded-xl border p-3 text-left transition ${sign.id === project.value.activeSignId ? "border-blue-400 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
                  onClick$={() => {
                    commit("切换标识", (draft) => { draft.activeSignId = sign.id; });
                    selectedVersionId.value = "";
                  }}
                >
                  <div class="flex items-center justify-between">
                    <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                    <span class={`badge badge-sm ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                  </div>
                  {inspection && (
                    <div class="mt-1 flex items-center gap-1">
                      <span class={`badge badge-xs ${fieldStale ? "badge-warning" : fieldOpen ? "badge-error" : inspection.match === "consistent" ? "badge-success" : "badge-ghost"}`}>
                        {fieldStale ? "现场结论失效" : fieldOpen ? "现场问题未处理" : inspection.match === "consistent" ? "现场一致" : "现场不符"}
                      </span>
                      <span class="text-[10px] text-slate-400">{inspection.usableWidthMm}mm</span>
                    </div>
                  )}
                  <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.sourceText}</div>
                  <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{sign.targetLanguage}</span>
                    <span class={risk.risk === "high" ? "font-bold text-error" : risk.risk === "medium" ? "font-bold text-warning" : "text-success"}>
                      {risk.risk === "high" ? "高风险" : risk.risk === "medium" ? "需留意" : "版面正常"}
                    </span>
                  </div>
                  <span class="sr-only">第 {index + 1} 条</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main class="min-w-0 bg-white">
          <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <div class="flex items-start justify-between gap-5">
              <div>
                <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{active().code} · {active().scenario}</div>
                <h1 class="mt-1 text-xl font-bold">中文原文与译文校对</h1>
              </div>
              <div class="join">
                {(["draft", "pending", "changes", "confirmed"] as ReviewStatus[]).map((status) => {
                  const guard = status === "confirmed" ? signConfirmBlocked(active()) : { blocked: false, reasons: [] };
                  return (
                    <button
                      key={status}
                      class={`btn join-item btn-sm ${active().status === status ? "btn-primary" : "btn-outline"} ${guard.blocked ? "tooltip tooltip-bottom before:max-w-56" : ""}`}
                      disabled={guard.blocked}
                      data-tip={guard.blocked ? guard.reasons.join("；") : undefined}
                      onClick$={() => setStatus(status)}
                    >
                      {STATUS_LABELS[status]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div class="space-y-5 p-6">
            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Source</div><h2 class="font-bold">中文原文</h2></div>
                  <span class="badge badge-ghost">简体中文</span>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-24 w-full text-base leading-7"
                  value={active().sourceText}
                  onInput$={(_, element) => updateActive("修改中文原文", (sign) => { sign.sourceText = element.value; sign.status = "draft"; })}
                />
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body gap-4 p-5">
                <div class="grid grid-cols-2 gap-4">
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">目标语言</span>
                    <select class="select select-bordered" value={active().targetLanguage} onChange$={(_, element) => updateActive("修改目标语言", (sign) => { sign.targetLanguage = element.value; sign.status = "pending"; })}>
                      {["English", "日本語", "Français", "Deutsch", "한국어", "Español"].map((language) => <option key={language}>{language}</option>)}
                    </select>
                  </label>
                  <label class="form-control">
                    <span class="label-text mb-1 text-xs font-bold text-slate-500">适用场景</span>
                    <input class="input input-bordered" value={active().scenario} onInput$={(_, element) => updateActive("修改适用场景", (sign) => { sign.scenario = element.value; })} />
                  </label>
                </div>
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">法规或规范提示</span>
                  <input class="input input-bordered" value={active().regulation} onInput$={(_, element) => updateActive("修改法规提示", (sign) => { sign.regulation = element.value; })} />
                </label>
                <div class="divider my-0"></div>
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-500">Target</div><h2 class="font-bold">目标语言译文</h2></div>
                  <button class="btn btn-sm btn-outline" onClick$={saveVersion}>保存版本快照</button>
                </div>
                <textarea
                  class="textarea textarea-bordered min-h-36 w-full text-lg leading-8"
                  value={active().targetText}
                  onInput$={(_, element) => updateActive("修改译文", (sign) => { sign.targetText = element.value; sign.status = sign.emergencyRevision ? "changes" : "pending"; })}
                />
                <div class="flex flex-wrap gap-2">
                  {active().terms.map((term) => {
                    const matched = active().targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase());
                    return (
                      <button
                        key={term.id}
                        title="点击切换术语确认状态"
                        class={`badge badge-lg gap-1 ${matched && term.confirmed ? "badge-success" : matched ? "badge-warning" : "badge-error"}`}
                        onClick$={() => updateActive("确认术语", (sign) => {
                          const current = sign.terms.find((item) => item.id === term.id);
                          if (current) current.confirmed = !current.confirmed;
                        })}
                      >
                        {term.source} → {term.target} {matched ? (term.confirmed ? "✓" : "!") : "×"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">术语绑定</h2><p class="text-xs text-slate-500">必选术语未出现在译文中时会实时告警。</p></div>
                  <span class="badge badge-outline">{active().terms.length} 条</span>
                </div>
                <div class="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input class="input input-sm input-bordered" placeholder="中文术语" value={termSource.value} onInput$={(_, element) => termSource.value = element.value} />
                  <input class="input input-sm input-bordered" placeholder="目标语言固定译法" value={termTarget.value} onInput$={(_, element) => termTarget.value = element.value} />
                  <button class="btn btn-sm btn-primary" onClick$={addTerm}>绑定</button>
                </div>
                <div class="mt-3 grid gap-2 md:grid-cols-2">
                  {active().terms.map((term) => (
                    <div key={term.id} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <div class="min-w-0">
                        <div class="truncate text-xs font-bold">{term.source}</div>
                        <div class="truncate text-xs text-slate-500">{term.target}</div>
                      </div>
                      <div class="flex gap-1">
                        <button class={`btn btn-xs ${term.confirmed ? "btn-success" : "btn-ghost"}`} onClick$={() => updateActive("确认术语", (sign) => { const target = sign.terms.find((item) => item.id === term.id); if (target) target.confirmed = !target.confirmed; })}>确认</button>
                        <button class="btn btn-xs btn-ghost text-error" onClick$={() => updateActive("删除术语", (sign) => { sign.terms = sign.terms.filter((item) => item.id !== term.id); })}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              {(() => {
                const inspection = active().fieldInspection;
                const { blocked, reasons } = signConfirmBlocked(active());
                const stale = inspection
                  ? inspection.sourceSnapshot !== active().sourceText || inspection.targetSnapshot !== active().targetText
                  : false;
                return (
                  <div class="card-body p-5">
                    <div class="flex items-center justify-between">
                      <div>
                        <h2 class="font-bold">现场核对结论</h2>
                        <p class="text-xs text-slate-500">巡检员在现场按标识编号核对后导回；改了稿子，旧结论会自动标记失效。</p>
                      </div>
                      {inspection ? (
                        <span class={`badge ${stale ? "badge-warning" : inspection.match === "consistent" ? "badge-success" : "badge-error"}`}>
                          {stale ? "已失效·待重新确认" : inspection.match === "consistent" ? "实物一致" : "实物不符"}
                        </span>
                      ) : (
                        <span class="badge badge-ghost">无现场记录</span>
                      )}
                    </div>

                    {!inspection && (
                      <div class="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">
                        还没有这条标识的现场记录。请用只读预览链接现场核对，再把记录粘贴到右侧“现场记录导入”。
                      </div>
                    )}

                    {inspection && (
                      <div class="mt-3 space-y-3">
                        {stale && (
                          <div class="alert alert-warning py-2 text-xs">
                            <span>导入结论之后原文或译文已改动，现场结论失效，需要重新现场确认后才能标记已确认。</span>
                          </div>
                        )}
                        <div class="grid gap-3 sm:grid-cols-3">
                          <div class="rounded-lg bg-slate-50 p-3">
                            <div class="text-[11px] font-bold text-slate-400">实物与稿子</div>
                            <div class={`mt-1 text-sm font-bold ${inspection.match === "consistent" ? "text-success" : "text-error"}`}>
                              {inspection.match === "consistent" ? "一致" : "不一致"}
                            </div>
                          </div>
                          <div class="rounded-lg bg-slate-50 p-3">
                            <div class="text-[11px] font-bold text-slate-400">现场可用宽度</div>
                            <div class="mt-1 text-sm font-bold">{inspection.usableWidthMm} mm</div>
                          </div>
                          <div class="rounded-lg bg-slate-50 p-3">
                            <div class="text-[11px] font-bold text-slate-400">巡检员 / 现场时间</div>
                            <div class="mt-1 truncate text-xs">{inspection.inspector}</div>
                            <div class="text-[11px] text-slate-500">{new Date(inspection.inspectedAt).toLocaleString()}</div>
                          </div>
                        </div>
                        <div class="rounded-lg border border-slate-200 p-3">
                          <div class="flex items-center justify-between">
                            <span class="text-[11px] font-bold text-slate-400">具体问题</span>
                            {inspection.match === "mismatch" && (
                              <button
                                class={`btn btn-xs ${inspection.issueHandled ? "btn-success" : "btn-outline"}`}
                                disabled={stale}
                                title={stale ? "结论已失效，请先重新现场确认" : "标记现场问题已处理"}
                                onClick$={() => toggleIssueHandled(active().id)}
                              >
                                {inspection.issueHandled ? "问题已处理" : "标记已处理"}
                              </button>
                            )}
                          </div>
                          <p class={`mt-1 whitespace-pre-line text-sm ${inspection.issue && inspection.issue !== "无" ? "text-slate-700" : "text-slate-400"}`}>{inspection.issue || "无"}</p>
                        </div>
                        {blocked && (
                          <div class="rounded-lg border border-error/40 bg-error/5 px-3 py-2 text-xs text-error">
                            不能标记已确认：{reasons.join("；")}
                          </div>
                        )}
                        <div class="text-[11px] text-slate-400">导回时间：{new Date(inspection.importedAt).toLocaleString()}</div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </section>

            <section class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-5">
                <h2 class="font-bold">审校意见与回复</h2>
                <div class="mt-3 flex gap-2">
                  <textarea class="textarea textarea-bordered min-h-20 flex-1" placeholder="记录措辞、文化适配或法规依据…" value={commentDraft.value} onInput$={(_, element) => commentDraft.value = element.value} />
                  <button class="btn btn-primary self-end" onClick$={addComment}>添加意见</button>
                </div>
                <div class="mt-4 space-y-3">
                  {active().comments.length === 0 && <div class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">还没有审校意见。</div>}
                  {active().comments.map((comment) => (
                    <article key={comment.id} class={`rounded-xl border-l-4 bg-slate-50 p-3 ${comment.resolved ? "border-success opacity-60" : "border-warning"}`}>
                      <div class="flex items-center justify-between text-xs"><strong>{comment.author}</strong><span class="text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span></div>
                      <p class="my-2 text-sm">{comment.body}</p>
                      {comment.replies.map((reply) => (
                        <div key={reply.id} class="ml-4 my-1 border-l-2 border-slate-200 pl-3 text-xs"><strong>{reply.author}</strong>：{reply.body}</div>
                      ))}
                      {replyingTo.value === comment.id ? (
                        <div class="mt-2 flex gap-2">
                          <input class="input input-xs input-bordered flex-1" value={replyDraft.value} onInput$={(_, element) => replyDraft.value = element.value} />
                          <button class="btn btn-xs btn-primary" onClick$={() => addReply(comment.id)}>发送</button>
                        </div>
                      ) : (
                        <div class="mt-2 flex gap-2">
                          <button class="btn btn-xs btn-ghost" onClick$={() => { replyingTo.value = comment.id; }}>回复</button>
                          <button class="btn btn-xs btn-ghost" onClick$={() => updateActive("更新意见状态", (sign) => { const item = sign.comments.find((entry) => entry.id === comment.id); if (item) item.resolved = !item.resolved; })}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </main>

        <aside class="overflow-y-auto bg-slate-50 p-4">
          <section class="sticky top-4 space-y-4">
            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Live Preview</div><h2 class="font-bold">版面实时预览</h2></div>
                  <span class={`badge ${preview().risk === "high" ? "badge-error" : preview().risk === "medium" ? "badge-warning" : "badge-success"}`}>
                    {preview().risk === "high" ? "溢出风险" : preview().risk === "medium" ? "接近边界" : "版面安全"}
                  </span>
                </div>
                <div class="mt-3 flex gap-1">
                  {WIDTHS.map((width) => <button key={width} class={`btn btn-xs flex-1 ${previewWidth.value === width ? "btn-primary" : "btn-outline"}`} onClick$={() => previewWidth.value = width}>{width}px</button>)}
                </div>
                <div class="mt-2 flex items-center gap-3 text-xs">
                  <span class="w-20">字号 {previewFont.value}px</span>
                  <input type="range" min="28" max="88" step="2" class="range range-primary range-xs flex-1" value={previewFont.value} onInput$={(_, element) => previewFont.value = Number(element.value)} />
                </div>
                <div class="mt-4 overflow-hidden rounded-xl bg-slate-800 p-3">
                  <div class="mx-auto grid min-h-48 place-items-center overflow-hidden border-4 border-white bg-[#174f3d] p-3 text-center text-white" style={{ width: `${previewWidth.value}px`, maxWidth: "100%" }}>
                    <div>
                      <div style={{ fontSize: `${previewFont.value}px` }} class="font-black leading-[1.18] tracking-wide">{preview().visible.map((line, index) => <div key={index}>{line || "\u00a0"}</div>)}</div>
                    </div>
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{preview().lines.length}</strong><span>预计行数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{active().targetText.length}</strong><span>字符数</span></div>
                  <div class="rounded-lg bg-slate-100 p-2"><strong class={`block text-lg ${preview().missingTerms.length ? "text-error" : "text-success"}`}>{preview().missingTerms.length}</strong><span>缺失术语</span></div>
                </div>
                {(preview().overflow || preview().tooLong) && <div class="alert alert-error mt-3 py-2 text-xs">{preview().overflow ? "当前字号下内容超过三行，可能截断。" : "译文接近标识建议字符上限。"}</div>}
              </div>
            </div>

            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">现场记录导入</h2><p class="text-xs text-slate-500">粘贴巡检员带回的记录，按标识编号逐条对账。</p></div>
                </div>
                <textarea
                  class="textarea textarea-bordered mt-3 min-h-28 w-full font-mono text-xs leading-5"
                  placeholder={`# ${FIELD_PAYLOAD_MARKER} …\n{"code":"TR-01","match":"mismatch",…}`}
                  value={fieldPayload.value}
                  onInput$={(_, el) => fieldPayload.value = el.value}
                />
                <div class="mt-2 flex gap-2">
                  <button class="btn btn-sm btn-primary flex-1" onClick$={importFromBox}>导入对账</button>
                </div>
                {importNotice.value && <div class="alert alert-info mt-2 py-2 text-xs"><span>{importNotice.value}</span></div>}

                {failedEntries.value.length > 0 && (
                  <div class="mt-3 rounded-xl border border-error/40 bg-error/5 p-3">
                    <div class="flex items-center justify-between">
                      <div class="text-xs font-bold text-error">导入失败 · 原样保留 {failedEntries.value.length} 条</div>
                      <button class="btn btn-xs btn-outline" onClick$={retryAllFailed}>全部重试</button>
                    </div>
                    <p class="mt-1 text-[11px] text-slate-500">编号对不上或内容读不了；译文和意见不受影响。改正记录后可逐条重试。</p>
                    <ul class="mt-2 space-y-2">
                      {failedEntries.value.map((entry) => (
                        <li key={entry.id} class="rounded-lg border border-slate-200 bg-white p-2">
                          <div class="text-[11px] font-bold text-error">{entry.reason}</div>
                          <div class="mt-1 break-all font-mono text-[10px] leading-4 text-slate-500">{entry.raw}</div>
                          <div class="mt-1 flex justify-end gap-1">
                            <button class="btn btn-xs btn-ghost" onClick$={() => retryEntry(entry)}>重试</button>
                            <button class="btn btn-xs btn-ghost text-slate-400" onClick$={() => removeFailedEntry(entry)}>删除</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <div class="card border border-slate-200 bg-white shadow-sm">
              <div class="card-body p-4">
                <div class="flex items-center justify-between">
                  <div><h2 class="font-bold">版本比较</h2><p class="text-xs text-slate-500">旧版快照与当前译文逐词对比。</p></div>
                  <span class="badge badge-outline">{active().versions.length} 版</span>
                </div>
                {active().versions.length ? (
                  <>
                    <select class="select select-sm select-bordered mt-3 w-full" value={selectedVersionId.value || active().versions[0].id} onChange$={(_, element) => selectedVersionId.value = element.value}>
                      {active().versions.map((version) => <option key={version.id} value={version.id}>{`${version.label} · ${new Date(version.createdAt).toLocaleTimeString()}`}</option>)}
                    </select>
                    <div class="mt-3 rounded-lg bg-slate-900 p-3 text-sm leading-7 text-slate-100">
                      {comparison().map((token, index) => (
                        <span key={index} class={token.type === "add" ? "rounded bg-green-400/25 text-green-200" : token.type === "remove" ? "bg-red-400/25 text-red-200 line-through" : ""}>{token.value}</span>
                      ))}
                    </div>
                    <div class="mt-2 flex gap-3 text-[11px]"><span class="text-green-700">绿：新增</span><span class="text-red-700">红：删除</span></div>
                  </>
                ) : (
                  <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">保存当前译文后会在这里生成可比较版本。</div>
                )}
              </div>
            </div>

            <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
              <div class="mb-2 font-bold text-white">键盘操作</div>
              <div class="grid grid-cols-2 gap-y-1"><span><kbd class="kbd kbd-xs">J/K</kbd> 切换标识</span><span><kbd class="kbd kbd-xs">[ ]</kbd> 预览宽度</span><span><kbd class="kbd kbd-xs">- =</kbd> 字号</span><span><kbd class="kbd kbd-xs">Ctrl/⌘ Z</kbd> 撤销</span></div>
            </div>
          </section>
        </aside>
      </div>

      {toast.value && <div class="toast toast-end z-50"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
