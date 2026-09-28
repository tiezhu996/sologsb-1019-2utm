import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type { Adjudication, AdjudicationBasis, CoderId, CodingState, PersistedEnvelope, Segment, Theme } from '../types';
import { readEnvelope, writeEnvelope } from '../utils/db';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const TAB_ID = crypto.randomUUID();

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CodingState;
      // 兼容裁决功能上线前的旧存档
      if (!Array.isArray(parsed.adjudications)) parsed.adjudications = [];
      if (typeof parsed.arbitrator !== 'string') parsed.arbitrator = '主持人';
      return parsed;
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return seedState();
};

/** 两位编码者对同一片段的判断是否存在分歧（顺序敏感，与界面高亮口径一致） */
export const isDisagreement = (segment: Segment) =>
  segment.assignments.A.join('|') !== segment.assignments.B.join('|');

/** 由主题 id 解析层级路径名，如「教育经历 / 学校选择」 */
export const themePathOf = (themeId: string, themes: Theme[]): string => {
  const names: string[] = [];
  let current = themes.find((theme) => theme.id === themeId);
  while (current) {
    names.unshift(current.name);
    current = current.parentId ? themes.find((theme) => theme.id === current!.parentId) : undefined;
  }
  return names.length ? names.join(' / ') : '未知主题';
};

const cloneState = (state: CodingState): CodingState => structuredClone(unwrap(state));

const [state, setState] = createStore<CodingState>(loadLocal());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [remoteEnvelope, setRemoteEnvelope] = createSignal<PersistedEnvelope | null>(null);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
let channel: BroadcastChannel | null = null;
let hydrating = false;
let saveTimer: number | undefined;

const persist = (snapshot: CodingState) => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const envelope: PersistedEnvelope = {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      writerId: TAB_ID,
      state: snapshot
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    await writeEnvelope(envelope);
    setLastSavedAt(new Date());
    channel?.postMessage(envelope);
  }, 180);
};

createEffect(() => {
  const snapshot = cloneState(state);
  if (!storageReady()) return;
  persist(snapshot);
});

const transaction = (action: string, detail: string, mutator: (draft: CodingState) => void) => {
  setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
  setRedoStack([]);
  const next = cloneState(state);
  mutator(next);
  next.revision = state.revision + 1;
  next.updatedAt = new Date().toISOString();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  persist(next);
};

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const stored = await readEnvelope();
      const local = cloneState(state);
      if (stored && (stored.revision > local.revision || stored.updatedAt > local.updatedAt)) {
        setRemoteEnvelope(stored);
      }
    } finally {
      setStorageReady(true);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('sologsb-1019-coding');
      channel.onmessage = (event: MessageEvent<PersistedEnvelope>) => {
        const incoming = event.data;
        if (!incoming || incoming.writerId === TAB_ID) return;
        if (incoming.revision === state.revision && incoming.updatedAt === state.updatedAt) return;
        setRemoteEnvelope(incoming);
      };
    }
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, cloneState(state)]);
    setState(reconcile(previous, { merge: false }));
    persist(previous);
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, cloneState(state)]);
    setState(reconcile(next, { merge: false }));
    persist(next);
  };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);
  const setCoder = (coder: CoderId, name: string) => {
    if (coder === 'A') setState('coderA', name);
    else setState('coderB', name);
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    transaction('调整编码', `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const codes = new Set(segment.assignments[coder]);
      if (enabled) codes.add(themeId);
      else codes.delete(themeId);
      segment.assignments[coder] = [...codes];
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      draft.segments.forEach((segment) => {
        if (segmentIds.includes(segment.id) && !segment.assignments[coder].includes(themeId)) segment.assignments[coder].push(themeId);
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    transaction('新建主题', name, (draft) => {
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    transaction('编辑主题', fieldLabel, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme) Object.assign(theme, patch);
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction('删除主题', theme.name, (draft) => {
      draft.themes = draft.themes.filter((item) => item.id !== themeId);
      draft.themes.forEach((item) => { if (item.parentId === themeId) item.parentId = null; });
      draft.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((id) => id !== themeId);
        segment.assignments.B = segment.assignments.B.filter((id) => id !== themeId);
      });
      // 裁决记录独立留档：删除主题时移除悬空引用，其余裁决结论与依据保留
      draft.adjudications.forEach((adjudication) => {
        adjudication.themeIds = adjudication.themeIds.filter((id) => id !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const codes = new Set(segment.assignments[coder].filter((id) => id !== sourceId));
          if (segment.assignments[coder].includes(sourceId)) codes.add(targetId);
          segment.assignments[coder] = [...codes];
        });
      });
      // 同步改写裁决引用：来源主题并入目标主题，并去重
      draft.adjudications.forEach((adjudication) => {
        if (!adjudication.themeIds.includes(sourceId)) return;
        const ids = adjudication.themeIds.filter((id) => id !== sourceId);
        if (!ids.includes(targetId)) ids.push(targetId);
        adjudication.themeIds = ids;
      });
      draft.themes.forEach((theme) => { if (theme.parentId === sourceId) theme.parentId = targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== sourceId);
      draft.activeThemeId = targetId;
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${crypto.randomUUID()}`;
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      draft.themes.push({ ...source, id: newId, name: newName, examples: [] });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => id === sourceId ? newId : id);
          }
        });
        // 被拆走片段上的裁决引用同步指向新主题
        const adjudication = draft.adjudications.find((item) => item.segmentId === segment.id);
        if (adjudication && adjudication.themeIds.includes(sourceId)) {
          adjudication.themeIds = adjudication.themeIds.map((id) => id === sourceId ? newId : id);
        }
      });
      draft.activeThemeId = newId;
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: `s-${crypto.randomUUID()}`,
        transcriptId,
        order: start + index,
        speaker: row.speaker,
        time: row.time,
        text: row.text,
        assignments: { A: [], B: [] },
        note: ''
      }));
      draft.segments.push(...segments);
      draft.activeTranscriptId = transcriptId;
      draft.activeSegmentId = segments[0]?.id ?? draft.activeSegmentId;
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    transaction('添加主题示例', trimmed, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme && !theme.examples.includes(trimmed)) theme.examples.push(trimmed);
    });
  };

  const setArbitrator = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === state.arbitrator) return;
    transaction('设置裁决人', trimmed, (draft) => { draft.arbitrator = trimmed; });
  };

  /** 对一条分歧片段下裁决：采纳 A / 采纳 B / 合成双方主题，并写依据。原有判断不被覆盖。 */
  const adjudicate = (segmentId: string, basis: AdjudicationBasis, themeIds: string[], rationale: string) => {
    const segment = state.segments.find((item) => item.id === segmentId);
    const exists = state.adjudications.some((item) => item.segmentId === segmentId);
    // 新裁决只针对当前仍有分歧的片段；已留档的裁决在分歧消除后仍允许修订
    if (!segment || (!exists && !isDisagreement(segment))) return;
    const trimmedRationale = rationale.trim();
    if (!trimmedRationale) return;
    const validIds = [...new Set(themeIds)].filter((id) => state.themes.some((theme) => theme.id === id));
    if (!validIds.length) return;
    const basisLabel = basis === 'A' ? `采纳 ${state.coderA}` : basis === 'B' ? `采纳 ${state.coderB}` : '合成双方主题';
    transaction(exists ? '修订裁决' : '分歧裁决', `${basisLabel} · 片段 ${segment.time}`, (draft) => {
      const record: Adjudication = {
        id: `adj-${crypto.randomUUID()}`,
        segmentId,
        themeIds: validIds,
        basis,
        rationale: trimmedRationale,
        decidedAt: new Date().toISOString(),
        decidedBy: draft.arbitrator
      };
      draft.adjudications = draft.adjudications.filter((item) => item.segmentId !== segmentId);
      draft.adjudications.push(record);
    });
  };

  /** 撤销裁决：只删除独立留档的裁决记录，两位编码者原来的判断保持不变 */
  const clearAdjudication = (segmentId: string) => {
    const record = state.adjudications.find((item) => item.segmentId === segmentId);
    if (!record) return;
    transaction('撤销裁决', `片段 ${state.segments.find((item) => item.id === segmentId)?.time ?? segmentId}`, (draft) => {
      draft.adjudications = draft.adjudications.filter((item) => item.segmentId !== segmentId);
    });
  };

  const adjudicationFor = (segmentId: string) => state.adjudications.find((item) => item.segmentId === segmentId);

  const exportCoding = (format: 'json' | 'csv') => {
    if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...cloneState(state) }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [[
      '片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录',
      '裁决状态', '裁决主题路径', '裁决依据'
    ].map(escape).join(',')];
    state.segments.forEach((segment) => {
      const adjudication = state.adjudications.find((item) => item.segmentId === segment.id);
      const adjudicatedPaths = adjudication
        ? adjudication.themeIds.map((id) => themePathOf(id, state.themes)).join(' | ')
        : '';
      const status = adjudication
        ? `已裁决·${adjudication.basis === 'A' ? `采纳${state.coderA}` : adjudication.basis === 'B' ? `采纳${state.coderB}` : '合成'}`
        : '未裁决';
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
        const themeIds = segment.assignments[coder];
        const paths = themeIds.length ? themeIds.map((id) => themePathOf(id, state.themes)) : ['未编码'];
        rows.push([
          segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segment.note,
          status, adjudicatedPaths, adjudication?.rationale ?? ''
        ].map(escape).join(','));
      });
    });
    return `\uFEFF${rows.join('\n')}`;
  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const keepLocalVersion = () => {
    setRemoteEnvelope(null);
    transaction('处理多标签冲突', '保留当前标签页版本并生成新修订', () => undefined);
  };

  const applyRemoteVersion = () => {
    const remote = remoteEnvelope();
    if (!remote) return;
    setUndoStack((items) => [...items, cloneState(state)]);
    setRedoStack([]);
    setState(reconcile(remote.state, { merge: false }));
    setRemoteEnvelope(null);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  return {
    state,
    initialize,
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    adjudicate,
    clearAdjudication,
    adjudicationFor,
    setArbitrator,
    exportCoding,
    downloadExport,
    orderedThemes,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt
  };
}
