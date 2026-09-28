export type CoderId = 'A' | 'B';

// 裁决结论来源：采纳编码者 A、采纳编码者 B、合成双方主题或研究者自定义组合
export type AdjudicationSource = 'A' | 'B' | 'combined' | 'custom';

export interface Adjudication {
  id: string;
  segmentId: string;
  resolvedThemeIds: string[];
  rationale: string;
  source: AdjudicationSource;
  adjudicatorName: string;
  createdAt: string;
  updatedAt: string;
  // 裁决作出时两位编码者原始判断的独立留档，后续编码调整不会回写此快照
  coderSnapshot: Record<CoderId, string[]>;
}

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  definition: string;
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
}

export interface CodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  adjudications: Adjudication[];
  audit: Array<{ id: string; at: string; action: string; detail: string }>;
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}
