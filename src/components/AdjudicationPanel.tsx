import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Button, Chip } from '@suid/material';
import type { AdjudicationBasis } from '../types';
import type { useCodingStore } from '../store/coding-store';
import { themePathOf } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

export default function AdjudicationPanel(props: { store: Store; segmentId: string; editable: boolean }) {
  const [basis, setBasis] = createSignal<AdjudicationBasis | ''>('');
  const [picked, setPicked] = createSignal<string[]>([]);
  const [rationale, setRationale] = createSignal('');
  const [editing, setEditing] = createSignal(false);

  const segment = () => props.store.state.segments.find((item) => item.id === props.segmentId);
  const existing = () => props.store.adjudicationFor(props.segmentId);

  // 切换片段时收起表单，避免把上一条片段的裁决草稿带到新片段
  createEffect(() => {
    props.segmentId;
    setEditing(false);
    setBasis('');
    setPicked([]);
    setRationale('');
  });

  const unionThemes = createMemo(() => {
    const current = segment();
    if (!current) return [];
    return [...new Set([...current.assignments.A, ...current.assignments.B])];
  });

  const startEdit = () => {
    const record = existing();
    if (record) {
      setBasis(record.basis);
      setPicked(record.themeIds);
      setRationale(record.rationale);
    } else {
      setBasis('');
      setPicked([]);
      setRationale('');
    }
    setEditing(true);
  };

  const chooseBasis = (next: AdjudicationBasis) => {
    const current = segment();
    setBasis(next);
    if (!current) return;
    if (next === 'A') setPicked(current.assignments.A);
    else if (next === 'B') setPicked(current.assignments.B);
    else setPicked([...new Set([...current.assignments.A, ...current.assignments.B])]);
  };

  const togglePicked = (id: string) => {
    setPicked((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  };

  const canSubmit = () => Boolean(basis()) && picked().length > 0 && rationale().trim().length > 0;

  const submit = () => {
    if (!canSubmit() || !basis()) return;
    props.store.adjudicate(props.segmentId, basis() as AdjudicationBasis, picked(), rationale());
    setEditing(false);
  };

  const basisLabel = (value: AdjudicationBasis) =>
    value === 'A' ? `采纳 ${props.store.state.coderA}` : value === 'B' ? `采纳 ${props.store.state.coderB}` : '合成双方主题';

  const shownRecord = createMemo(() => existing() && !editing() ? existing() : null);

  return (
    <div class="adjudication-block">
      <Show
        when={shownRecord()}
        fallback={
          <Show when={editing()} fallback={
            <Button size="small" variant="outlined" onClick={startEdit}>⚖ 对此分歧进行裁决</Button>
          }>
            <div class="adj-form">
              <div class="adj-heading">⚖ 分歧裁决 <span>结论独立留档，不改动两位编码者的原始判断</span></div>
              <div class="adj-basis">
                <button classList={{ active: basis() === 'A' }} onClick={() => chooseBasis('A')}>采纳 {props.store.state.coderA}</button>
                <button classList={{ active: basis() === 'B' }} onClick={() => chooseBasis('B')}>采纳 {props.store.state.coderB}</button>
                <button classList={{ active: basis() === 'merged' }} onClick={() => chooseBasis('merged')}>合成双方主题</button>
              </div>
              <Show when={basis()}>
                <div class="adj-pick-label">裁决主题（合成时可在双方判断范围内增减）</div>
                <div class="adj-pick">
                  <For each={unionThemes()}>
                    {(id) => (
                      <label classList={{ on: picked().includes(id) }}>
                        <input type="checkbox" checked={picked().includes(id)} onChange={() => togglePicked(id)} />
                        <Chip size="small" label={props.store.state.themes.find((theme) => theme.id === id)?.name ?? '未知主题'} />
                      </label>
                    )}
                  </For>
                </div>
                <label class="field-label">裁决依据
                  <textarea
                    class="native-textarea"
                    value={rationale()}
                    onInput={(event) => setRationale(event.currentTarget.value)}
                    placeholder="说明为何采纳某一方，或为何把两边主题合并为这一结论"
                  />
                </label>
                <div class="adj-actions">
                  <Button size="small" onClick={() => setEditing(false)}>取消</Button>
                  <Button size="small" variant="contained" disabled={!canSubmit()} onClick={submit}>
                    {existing() ? '保存修订' : '确认裁决'}
                  </Button>
                </div>
              </Show>
            </div>
          </Show>
        }
      >
        {(record) => (
          <div class="adj-record">
            <div class="adj-record-head">
              <span class="adj-badge">{basisLabel(record().basis)}</span>
              <span class="adj-meta">{record().decidedBy || props.store.state.arbitrator} · {new Date(record().decidedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div class="adj-themes">
              <For each={record().themeIds} fallback={<span class="muted">裁决主题已随主题删除被清空</span>}>
                {(id) => (
                  <button class="adj-theme-link" onClick={() => props.store.selectTheme(id)}>
                    {themePathOf(id, props.store.state.themes)}
                  </button>
                )}
              </For>
            </div>
            <p class="adj-rationale">“{record().rationale}”</p>
            <div class="adj-actions">
              <Button size="small" onClick={startEdit}>修订裁决</Button>
              <Button size="small" color="error" onClick={() => props.store.clearAdjudication(props.segmentId)}>撤销裁决</Button>
              <Show when={!props.editable}>
                <span class="adj-meta">两位编码者现已一致，裁决仍独立留档</span>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
