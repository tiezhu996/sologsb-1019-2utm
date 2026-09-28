export type CoderId = 'A' | 'B';

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

export type AdjudicationBasis = 'A' | 'B' | 'merged';

export interface Adjudication {
  id: string;
  segmentId: string;
  /** 裁决结论主题；采纳任一方时为该方快照，合成时由研究者在双方主题范围内勾选/补充 */
  themeIds: string[];
  /** 采纳编码者 A、采纳编码者 B，或把两边合成为一次裁决结论 */
  basis: AdjudicationBasis;
  /** 裁决依据：研究者写下的判断理由 */
  rationale: string;
  decidedAt: string;
  decidedBy: string;
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
  /** 独立留档的分歧裁决，不覆盖两位编码者原来的 assignments */
  adjudications: Adjudication[];
  arbitrator: string;
  audit: Array<{ id: string; at: string; action: string; detail: string }>;
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}
