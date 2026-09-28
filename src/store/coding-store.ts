import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type { AdjudicationSource, CoderId, CodingState, PersistedEnvelope, Segment, Theme } from '../types';
import { readEnvelope, writeEnvelope } from '../utils/db';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const TAB_ID = crypto.randomUUID();

// 旧版本存档没有裁决字段，载入时补齐，保证刷新恢复与跨标签页同步后结构一致
const normalizeState = (raw: CodingState): CodingState => ({
  ...raw,
  adjudications: Array.isArray(raw.adjudications) ? raw.adjudications : []
});

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw) as CodingState);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return seedState();
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
  next.revision = state.revision + 1;
  next.updatedAt = new Date().toISOString();
  mutator(next);
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

  const adjudicationFor = (segmentId: string) => state.adjudications.find((item) => item.segmentId === segmentId);

  // 裁决独立留档：只写入 adjudications，不改动两位编码者原来的 assignments
  const saveAdjudication = (segmentId: string, resolvedThemeIds: string[], rationale: string, source: AdjudicationSource) => {
    const segment = state.segments.find((item) => item.id === segmentId);
    if (!segment) return;
    const existing = adjudicationFor(segmentId);
    const sourceLabel = source === 'A' ? state.coderA : source === 'B' ? state.coderB : source === 'combined' ? '合成双方' : '研究者自定义';
    transaction(existing ? '修订分歧裁决' : '作出分歧裁决', `${segment.time} ${segment.speaker} · 采纳来源：${sourceLabel}`, (draft) => {
      const current = draft.segments.find((item) => item.id === segmentId)!;
      const snapshot = { A: [...current.assignments.A], B: [...current.assignments.B] };
      const found = draft.adjudications.find((item) => item.segmentId === segmentId);
      if (found) {
        found.resolvedThemeIds = [...resolvedThemeIds];
        found.rationale = rationale;
        found.source = source;
        found.updatedAt = draft.updatedAt;
        found.coderSnapshot = snapshot;
      } else {
        draft.adjudications.push({
          id: `adj-${crypto.randomUUID()}`,
          segmentId,
          resolvedThemeIds: [...resolvedThemeIds],
          rationale,
          source,
          adjudicatorName: state.coderA || '研究者',
          createdAt: draft.updatedAt,
          updatedAt: draft.updatedAt,
          coderSnapshot: snapshot
        });
      }
    });
  };

  const clearAdjudication = (segmentId: string) => {
    const existing = adjudicationFor(segmentId);
    if (!existing) return;
    transaction('撤回分歧裁决', '裁决记录与两位编码者的原始判断均保留可撤销历史', (draft) => {
      draft.adjudications = draft.adjudications.filter((item) => item.segmentId !== segmentId);
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
      // 裁决引用同样摘掉已删除主题，快照按同一规则同步
      draft.adjudications.forEach((adjudication) => {
        adjudication.resolvedThemeIds = adjudication.resolvedThemeIds.filter((id) => id !== themeId);
        adjudication.coderSnapshot.A = adjudication.coderSnapshot.A.filter((id) => id !== themeId);
        adjudication.coderSnapshot.B = adjudication.coderSnapshot.B.filter((id) => id !== themeId);
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
      // 同步改写裁决结论与裁决时的判断快照，保持引用指向合并后的主题
      draft.adjudications.forEach((adjudication) => {
        const retarget = (ids: string[]) => {
          const next = new Set(ids.filter((id) => id !== sourceId));
          if (ids.includes(sourceId)) next.add(targetId);
          return [...next];
        };
        adjudication.resolvedThemeIds = retarget(adjudication.resolvedThemeIds);
        adjudication.coderSnapshot.A = retarget(adjudication.coderSnapshot.A);
        adjudication.coderSnapshot.B = retarget(adjudication.coderSnapshot.B);
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
        // 被拆走的片段，其裁决结论与快照中的旧主题改指新主题
        const adjudication = draft.adjudications.find((item) => item.segmentId === segment.id);
        if (adjudication) {
          const move = (ids: string[]) => ids.map((id) => id === sourceId ? newId : id);
          adjudication.resolvedThemeIds = move(adjudication.resolvedThemeIds);
          adjudication.coderSnapshot.A = move(adjudication.coderSnapshot.A);
          adjudication.coderSnapshot.B = move(adjudication.coderSnapshot.B);
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

  const exportCoding = (format: 'json' | 'csv') => {
    const segmentMap = new Map(state.segments.map((segment) => [segment.id, segment]));
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...cloneState(state) }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const themePath = (id: string) => {
      const names: string[] = [];
      let current = themeMap.get(id);
      while (current) {
        names.unshift(current.name);
        current = current.parentId ? themeMap.get(current.parentId) : undefined;
      }
      return names.join(' / ');
    };
    const themePaths = (ids: string[]) => ids.length ? ids.map(themePath).join(' | ') : '未编码';
    // 每片段一行：原始双编码与裁决分列，便于把未裁决与已裁决分开核对
    const rows = [[
      '片段编号', '访谈', '时间', '发言人', '原文',
      `${state.coderA}主题路径`, `${state.coderB}主题路径`,
      '裁决状态', '裁决主题路径', '裁决依据', '裁决来源', '片段备忘录'
    ].map(escape).join(',')];
    const sorted = [...state.segments].sort((a, b) => (
      a.transcriptId < b.transcriptId ? -1 : a.transcriptId > b.transcriptId ? 1 : a.order - b.order
    ));
    const transcriptTitle = (id: string) => state.transcripts.find((item) => item.id === id)?.title ?? id;
    const sourceLabel = (source: AdjudicationSource) => (
      source === 'A' ? `采纳 ${state.coderA}` : source === 'B' ? `采纳 ${state.coderB}` : source === 'combined' ? '合成双方' : '研究者自定义'
    );
    sorted.forEach((segment) => {
      const adjudication = state.adjudications.find((item) => item.segmentId === segment.id);
      const disputed = segment.assignments.A.join('|') !== segment.assignments.B.join('|');
      const status = adjudication ? '已裁决' : disputed ? '待裁决分歧' : '一致';
      rows.push([
        segment.id,
        transcriptTitle(segment.transcriptId),
        segment.time,
        segment.speaker,
        segment.text,
        themePaths(segment.assignments.A),
        themePaths(segment.assignments.B),
        status,
        adjudication ? (adjudication.resolvedThemeIds.length ? adjudication.resolvedThemeIds.map(themePath).join(' | ') : '未选主题') : '',
        adjudication?.rationale ?? '',
        adjudication ? sourceLabel(adjudication.source) : '',
        segmentMap.get(segment.id)?.note ?? ''
      ].map(escape).join(','));
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
    setState(reconcile(normalizeState(remote.state), { merge: false }));
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
    adjudicationFor,
    saveAdjudication,
    clearAdjudication,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
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
