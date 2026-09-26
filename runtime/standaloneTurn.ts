import { Schema } from '../schema/schema';
import type { LocalContentEntryConfig, PresetConfig } from '../src/presets/types';
import type { MessageRecord } from '../src/stores/messages';
import type { ApiConfig, WorldDifficulty } from '../src/stores/settings';
import {
  mergeStandaloneAssistantDebugTrace,
  type StandaloneAiDebugPassTrace,
  type StandaloneAssistantDebugTrace,
} from '../src/utils/standaloneAiDebug';
import { normalizeRemoteApiErrorMessage } from '../src/utils/remoteApiError';
import {
  parseTaggedAssistantReply,
  replaceOrAppendUpdateVariableBlock,
  type ParsedTaggedAssistantReply,
} from '../src/utils/taggedReply';
import {
  isStandaloneMainWorldbookBlock,
  renderResolvedStandaloneLocalContentEntry,
  resolveStandaloneLocalContentBlocks,
  resolveStandaloneLocalContentEntries,
  resolveStandaloneMainWorldbookPrompt,
  type StandaloneBuiltinAssetRouteOverrideMap,
} from '../src/utils/standaloneLocalContent';
import {
  getActiveStandaloneTavernPresetDocument,
  parseStandaloneTavernPresetDocument,
  resolveOrderedStandaloneTavernPrompts,
} from '../src/utils/standaloneTavernPreset';
import {
  hasCompleteStandaloneApiConfig,
  requestStandaloneProviderText,
  type StandaloneProviderChatMessage,
  type StandaloneProviderReply,
} from '../src/utils/standaloneProviderApi';
import { formatMessageContentForDisplay } from '../src/utils/messageFormatting';
import { normalizeLineEndingsTrimmed as normalizeLineEndings } from '../src/utils/textNormalize';
import { applyVariableUpdatePatch, parseVariableUpdatePatch } from '../src/utils/variableUpdate';
import {
  applyStandalonePromptMacroReplacements,
  applyStandaloneTavernMacroState,
  buildStandaloneCurrentStatDataBlock,
  createStandaloneTavernMacroState,
} from './standalonePromptUtils';

type StandaloneStatData = ReturnType<typeof Schema.parse>;

export type StandaloneLocalTurnInput = {
  /** 主 API 候选，按顺序尝试 */
  mainApis: ApiConfig[];
  assistantApis?: ApiConfig[];
  /** 前一个失败时是否自动试下一个；缺省 true */
  autoRetry?: boolean;
  statData: StandaloneStatData;
  messages: MessageRecord[];
  latestUserMessage: MessageRecord;
  worldDifficulty: WorldDifficulty;
  localContentEnabledMap: Record<string, boolean>;
  localContentBuiltinRouteOverrides: StandaloneBuiltinAssetRouteOverrideMap;
  /** 玩家在设置里手动添加的条目；没选预设时靠它把内容送进提示词 */
  localContentCustomEntries?: LocalContentEntryConfig[];
  selectedPreset?: PresetConfig | null;
  onMainReplyPartialText?: (text: string) => void;
  scriptedTurn?: StandaloneScriptedTurnInput;
  /** 玩家手动归档出来的整体剧情摘要，空＝还没归档过 */
  stageSummary?: string;
  /** 归档水位线：message_id 小于等于它的回合已被上面那段覆盖 */
  archivedUntilMessageId?: number;
};

export type StandaloneScriptedTurnInput = {
  kind: 'lottery';
  promptText: string;
};

export type StandaloneLocalTurnOutcome = {
  assistantMessage: Omit<MessageRecord, 'message_id'>;
  usedApiLabel: string;
  finalizeVariableUpdate: Promise<StandaloneVariableUpdatePhaseOutcome>;
};

export type StandaloneVariableUpdateStatus = 'running' | 'success' | 'failed' | 'skipped';

export type StandaloneVariableUpdatePhaseOutcome = {
  assistantMessage: Omit<MessageRecord, 'message_id'>;
  nextStatData: StandaloneStatData;
  variableUpdateApplied: boolean;
  variableUpdateWarning: string | null;
  variableUpdateStatus: StandaloneVariableUpdateStatus;
  usedApiLabel: string;
};

const STANDALONE_VARIABLE_UPDATE_TIMEOUT_MS = 60_000;
const STANDALONE_VARIABLE_UPDATE_TIMEOUT_ERROR_MESSAGE = '变量更新补写超时，请稍后重试。';
/** 补丁「拿到块但应用失败」时，携带错误回执向辅助 API 纠错重试的次数上限 */
const STANDALONE_VARIABLE_UPDATE_APPLY_RETRY_LIMIT = 1;

export async function runStandaloneVariableUpdatePass(input: {
  /** 主 API 候选，按顺序尝试 */
  mainApis: ApiConfig[];
  assistantApis?: ApiConfig[];
  /** 前一个失败时是否自动试下一个；缺省 true */
  autoRetry?: boolean;
  statData: StandaloneStatData;
  messages: MessageRecord[];
  latestUserMessage: MessageRecord;
  targetAssistantMessage: MessageRecord;
  worldDifficulty: WorldDifficulty;
  localContentEnabledMap: Record<string, boolean>;
  localContentBuiltinRouteOverrides: StandaloneBuiltinAssetRouteOverrideMap;
  /** 玩家在设置里手动添加的条目；没选预设时靠它把内容送进提示词 */
  localContentCustomEntries?: LocalContentEntryConfig[];
  selectedPreset?: PresetConfig | null;
}): Promise<StandaloneVariableUpdatePhaseOutcome> {
  const sanitizedAssistantRawContent = normalizeLineEndings(
    stripUpdateVariableBlocks(input.targetAssistantMessage.raw_content),
  );
  const baseApplyResult = applyVariableUpdateFromReply(input.statData, sanitizedAssistantRawContent);
  let applyResult = baseApplyResult;
  let effectiveRawReply = sanitizedAssistantRawContent;
  let variableUpdateWarning: string | null = null;
  let variableUpdateApiLabel: string | null = null;
  let variableUpdateStatus: StandaloneVariableUpdateStatus = 'running';
  let debugTrace = input.targetAssistantMessage.debug_trace;

  if (activeStandaloneTurnController) {
    throw new Error('已有独立模式生成任务正在进行中');
  }

  const controller = new AbortController();
  activeStandaloneTurnController = controller;

  try {
    const secondPassOutcome = await runSecondPassVariableUpdateWithApplyRetry({
      turnInput: input,
      baseRawReply: sanitizedAssistantRawContent,
      signal: controller.signal,
      baseStatData: input.statData,
    });

    variableUpdateApiLabel = secondPassOutcome.variableUpdateApiLabel;
    debugTrace = mergeStandaloneAssistantDebugTrace(debugTrace, {
      variable_update_pass: secondPassOutcome.debugTrace?.variable_update_pass,
    });

    if (secondPassOutcome.applyResult) {
      applyResult = secondPassOutcome.applyResult;
      effectiveRawReply = secondPassOutcome.effectiveRawReply ?? sanitizedAssistantRawContent;
      variableUpdateWarning = null;
      variableUpdateStatus = secondPassOutcome.status;
    } else {
      variableUpdateWarning = secondPassOutcome.warning;
      variableUpdateStatus = secondPassOutcome.status;
    }

    const mainApiLabel = input.mainApis[0] ? toApiLabel(input.mainApis[0]) : '';
    const usedApiLabel =
      variableUpdateApiLabel && variableUpdateApiLabel !== mainApiLabel
        ? mainApiLabel
          ? `${mainApiLabel} + ${variableUpdateApiLabel}`
          : variableUpdateApiLabel
        : mainApiLabel;

    return {
      assistantMessage: {
        ...buildAssistantMessagePayload(applyResult.parsedReply, effectiveRawReply, debugTrace),
        variable_update_status: variableUpdateStatus,
        variable_update_warning: variableUpdateWarning,
      },
      nextStatData: applyResult.nextStatData,
      variableUpdateApplied: applyResult.variableUpdateApplied,
      variableUpdateWarning,
      variableUpdateStatus,
      usedApiLabel,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('standalone_variable_update_aborted');
    }

    throw error;
  } finally {
    if (activeStandaloneTurnController === controller) {
      activeStandaloneTurnController = null;
    }
  }
}

type VariableUpdateApplyResult = {
  parsedReply: ParsedTaggedAssistantReply;
  nextStatData: StandaloneStatData;
  variableUpdateApplied: boolean;
  errorMessage: string | null;
};

type StandalonePromptBundle = {
  systemPrompt: string;
  userPrompt: string;
};

type StandalonePromptMessagesBundle = {
  messages: StandaloneProviderChatMessage[];
};

export type StandaloneMainChainViewEntryKey =
  'system_protocol' | 'current_stat_snapshot' | 'active_worldbook' | 'recent_history' | 'latest_user_input';

export type StandaloneMainChainViewEntry = {
  key: StandaloneMainChainViewEntryKey;
  orderIndex: number;
  role: 'system' | 'user' | 'assistant';
};

export type StandaloneMainChainView = {
  mode: 'full';
  entries: StandaloneMainChainViewEntry[];
  rawPresetReferenceIdentifier: string;
  rawPresetReferenceName: string;
};

type StandalonePresetPromptDefinition = {
  identifier?: string;
  name?: string;
  enabled?: boolean;
  role?: 'system' | 'user' | 'assistant';
  content?: string;
  system_prompt?: boolean;
  marker?: boolean;
};

type ResolvedStandalonePresetPrompt = StandalonePresetPromptDefinition & {
  enabledInOrder: boolean;
};

type VariableUpdateSecondPassResult = {
  updateBlock: string | null;
  warning: string | null;
  usedApiLabel: string | null;
  debugTrace?: StandaloneAiDebugPassTrace;
};

/**
 * 上一轮补丁「拿到了 <UpdateVariable> 块、但逐条应用时失败」的纠错回执。
 * 重试时注入二段提示词，让辅助 API 修正路径/写法后重新输出整份补丁。
 */
type VariableUpdateApplyRetryFeedback = {
  errorMessage: string;
  failedPatchText: string | null;
};

type StandaloneVariableUpdatePromptSections = {
  variableSnapshotPrompt: string;
  wbPrompt: string;
  previousUserPrompt: string;
  assistantContentPrompt: string;
  metaSystemPrompt: string;
  mvuUpdatePrompt: string;
};

const RECENT_MESSAGE_LIMIT = 8;
const LOTTERY_LOCAL_CONTENT_BLOCK_PREFIX = '[本地内容:抽奖结果规则]';

const STANDALONE_PRESET_COMPACT_IDENTIFIERS = new Set(['main']);

const STANDALONE_PRESET_SKIP_IDENTIFIERS = new Set(['worldInfoBefore', 'worldInfoAfter', 'dialogueExamples']);

let activeStandaloneTurnController: AbortController | null = null;

export function isStandaloneLocalTurnActive(): boolean {
  return activeStandaloneTurnController !== null;
}

function resolvePromptMessageRole(prompt: StandalonePresetPromptDefinition): 'system' | 'user' | 'assistant' {
  if (prompt.role === 'assistant') {
    return 'assistant';
  }

  if (prompt.role === 'user') {
    return 'user';
  }

  if (prompt.role === 'system' || prompt.system_prompt) {
    return 'system';
  }

  return 'user';
}

function buildStandaloneMainProtocolBlock(localContentBlocks: string[], mainPresetBlock: string): string {
  const protocolLocalContentBlocks = localContentBlocks.filter(
    block =>
      !/^\[本地内容:当前变量快照\]/.test(block.trim()) &&
      // 世界书走独立注入通道（resolveStandaloneMainWorldbookPrompt → 主链路里单独成条），
      // 这里再拼一次会让同一份世界书在提示词里出现两遍。
      !isStandaloneMainWorldbookBlock(block),
  );

  return normalizeLineEndings(`
你的任务：
1. 根据当前游戏状态与最近对话继续剧情。
2. 回复时必须输出且只输出一段标签化结果，不要使用 Markdown 代码块。
3. 结果必须包含且仅包含一个 <contenttext> 正文块。
4. 可以按需输出 <summary>、<analysis_block>、<action_options>。
5. <analysis_block> 结束后，下一段必须立即输出 <contenttext>；标签外不得出现正文或解释性文字。
6. <summary> 必须在 </contenttext> 之后，且只能放总结；<action_options> 必须在正文结束后，且只能放行动选项。
7. <action_options> 内请给出 3 到 5 行可选行动，每行以 “1.”、“2.” 这样的编号开头。
8. 不要输出 <UpdateVariable>；变量变化会由后续专用流程单独处理。
9. 不要输出与标签协议无关的解释性前言。

标签协议示例：
<contenttext>
这里写剧情正文
</contenttext>
<summary>
这里写简短总结
</summary>
<action_options>
1. 选项一
2. 选项二
3. 选项三
</action_options>

${mainPresetBlock}

${protocolLocalContentBlocks.join('\n\n')}
`);
}

function resolveStandaloneRecentHistoryMessages(input: {
  messages: MessageRecord[];
  latestUserMessage: MessageRecord;
}): StandaloneProviderChatMessage[] {
  return input.messages
    .slice(-RECENT_MESSAGE_LIMIT)
    .filter(message => message.message_id !== input.latestUserMessage.message_id)
    .map(message => ({
      role: message.role,
      content: (message.content_text || message.raw_content || '（空）').trim() || '（空）',
    }));
}

export type StandalonePriorSummaryItem = {
  messageId: number;
  summary: string;
};

/**
 * 收集「已经掉出最近窗口、且还没被阶段总结覆盖」的回合小总结。
 *
 * 提示词拼装与玩家手动归档共用这一份口径 —— 否则两边算出来的条数对不上，
 * 会出现「界面说攒够了、点归档却说没有可归档内容」这种自相矛盾。
 */
export function collectStandalonePriorSummaryItems(input: {
  messages: MessageRecord[];
  archivedUntilMessageId?: number;
  excludeMessageId?: number;
}): StandalonePriorSummaryItem[] {
  const windowStart = Math.max(0, input.messages.length - RECENT_MESSAGE_LIMIT);
  const archivedUntilMessageId = input.archivedUntilMessageId ?? -1;

  return input.messages
    .slice(0, windowStart)
    .filter(message => message.role === 'assistant')
    .filter(message => message.message_id !== input.excludeMessageId)
    .filter(message => message.message_id > archivedUntilMessageId)
    .map(message => ({
      messageId: message.message_id,
      summary: typeof message.summary_content === 'string' ? message.summary_content.trim() : '',
    }))
    .filter(item => Boolean(item.summary));
}

function buildStandalonePriorSummaryBlock(input: {
  messages: MessageRecord[];
  latestUserMessage: MessageRecord;
  stageSummary?: string;
  archivedUntilMessageId?: number;
}): string {
  const stageSummary = typeof input.stageSummary === 'string' ? input.stageSummary.trim() : '';
  const pendingItems = collectStandalonePriorSummaryItems({
    messages: input.messages,
    archivedUntilMessageId: input.archivedUntilMessageId,
    excludeMessageId: input.latestUserMessage.message_id,
  });

  const blocks: string[] = [];

  if (stageSummary) {
    blocks.push(['[阶段总结]', '以下是更早剧情的归档摘要（越靠后越接近当前）：', stageSummary].join('\n'));
  }

  if (pendingItems.length > 0) {
    blocks.push(
      [
        '[前情提要]',
        '以下是尚未归档的更早回合剧情总结（按时间顺序，越靠后越接近当前）：',
        ...pendingItems.map(item => item.summary),
      ].join('\n\n'),
    );
  }

  return blocks.join('\n\n');
}

function resolveStandaloneLatestUserMessage(input: MessageRecord): StandaloneProviderChatMessage {
  return {
    role: 'user',
    content: input.content_text.trim() || input.raw_content.trim() || '（空）',
  };
}

function buildStandaloneOrderedMainMessages(input: {
  statData: StandaloneStatData;
  messages: MessageRecord[];
  latestUserMessage: MessageRecord;
  localContentBlocks: string[];
  includeFullPreset: boolean;
  /** 玩家手动归档出来的整体剧情摘要，空＝还没归档过 */
  stageSummary?: string;
  /** 归档水位线：message_id 小于等于它的回合已被上面那段覆盖 */
  archivedUntilMessageId?: number;
}): StandaloneProviderChatMessage[] {
  const orderedPrompts = resolveOrderedStandalonePresetPrompts();
  const messages: StandaloneProviderChatMessage[] = [];
  const tavernMacroState = createStandaloneTavernMacroState();
  let latestUserInjected = false;
  let statDataInjected = false;
  let worldbookInjected = false;
  let priorSummaryInjected = false;
  let mainPresetBlock = '';
  const activeWorldbookPrompt = resolveStandaloneMainWorldbookPrompt(input.localContentBlocks);
  const priorSummaryBlock = buildStandalonePriorSummaryBlock({
    messages: input.messages,
    latestUserMessage: input.latestUserMessage,
    stageSummary: input.stageSummary,
    archivedUntilMessageId: input.archivedUntilMessageId,
  });

  orderedPrompts.forEach(prompt => {
    if (!prompt.enabledInOrder || typeof prompt.identifier !== 'string') {
      return;
    }

    if (!input.includeFullPreset && !STANDALONE_PRESET_COMPACT_IDENTIFIERS.has(prompt.identifier)) {
      return;
    }

    if (prompt.identifier === 'main') {
      const content =
        typeof prompt.content === 'string'
          ? normalizeStandalonePresetPromptContent(
              applyStandaloneTavernMacroState(prompt.content, tavernMacroState),
              input.statData,
            )
          : '';
      if (!content) {
        return;
      }

      mainPresetBlock = content.trim();
      return;
    }

    if (prompt.identifier === 'chatHistory') {
      if (!statDataInjected) {
        messages.push({
          role: 'user',
          content: buildStandaloneCurrentStatDataBlock(input.statData),
        });
        statDataInjected = true;
      }

      if (activeWorldbookPrompt && !worldbookInjected) {
        messages.push({
          role: 'user',
          content: activeWorldbookPrompt,
        });
        worldbookInjected = true;
      }

      if (priorSummaryBlock && !priorSummaryInjected) {
        messages.push({
          role: 'user',
          content: priorSummaryBlock,
        });
        priorSummaryInjected = true;
      }

      messages.push(
        ...resolveStandaloneRecentHistoryMessages({
          messages: input.messages,
          latestUserMessage: input.latestUserMessage,
        }),
      );
      messages.push(resolveStandaloneLatestUserMessage(input.latestUserMessage));
      latestUserInjected = true;
      return;
    }

    if (STANDALONE_PRESET_SKIP_IDENTIFIERS.has(prompt.identifier)) {
      return;
    }

    const directContent =
      typeof prompt.content === 'string'
        ? normalizeStandalonePresetPromptContent(
            applyStandaloneTavernMacroState(prompt.content, tavernMacroState),
            input.statData,
          )
        : '';
    const resolvedContent = directContent.trim();

    if (!resolvedContent) {
      return;
    }

    messages.push({
      role: resolvePromptMessageRole(prompt),
      content: resolvedContent,
    });
  });

  messages.unshift({
    role: 'system',
    content: buildStandaloneMainProtocolBlock(input.localContentBlocks, mainPresetBlock),
  });

  if (!statDataInjected) {
    messages.push({
      role: 'user',
      content: buildStandaloneCurrentStatDataBlock(input.statData),
    });
    statDataInjected = true;
  }

  if (activeWorldbookPrompt && !worldbookInjected) {
    messages.push({
      role: 'user',
      content: activeWorldbookPrompt,
    });
    worldbookInjected = true;
  }

  if (priorSummaryBlock && !priorSummaryInjected) {
    messages.push({
      role: 'user',
      content: priorSummaryBlock,
    });
    priorSummaryInjected = true;
  }

  if (!latestUserInjected) {
    messages.push(resolveStandaloneLatestUserMessage(input.latestUserMessage));
  }

  return messages;
}

function normalizeStandalonePresetPromptContent(content: string, statData?: StandaloneStatData): string {
  const sanitizedLines = normalizeLineEndings(content)
    .split('\n')
    .filter(line => !/^\s*(忽略之前提示词|ignore previous prompts?)\s*$/i.test(line));

  const sanitized = sanitizedLines.join('\n').trim();

  return applyStandalonePromptMacroReplacements(sanitized, { statData });
}

function resolveOrderedStandalonePresetPrompts(): ResolvedStandalonePresetPrompt[] {
  const standalonePresetDocument = parseStandaloneTavernPresetDocument(getActiveStandaloneTavernPresetDocument());
  return resolveOrderedStandaloneTavernPrompts(standalonePresetDocument);
}

function toApiLabel(api: ApiConfig): string {
  return `${api.source}:${api.model}`;
}

function createTimedAbortSignal(input: { parentSignal: AbortSignal; timeoutMs: number; timeoutMessage: string }) {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(input.parentSignal.reason);
    }
  };

  if (input.parentSignal.aborted) {
    onParentAbort();
  } else {
    input.parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error(input.timeoutMessage));
    }
  }, input.timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => didTimeout,
    timeoutError: new Error(input.timeoutMessage),
    cleanup: () => {
      clearTimeout(timeoutId);
      input.parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

/** 挑出配置完整、能真正发起请求的主 API 候选 */
function resolveConfiguredMainApis(mainApis: ApiConfig[] | undefined): ApiConfig[] {
  return (mainApis ?? []).filter(api => hasCompleteStandaloneApiConfig(api));
}

function resolveConfiguredAssistantApis(assistantApis: ApiConfig[] | undefined): ApiConfig[] {
  return (assistantApis ?? []).filter(api => hasCompleteStandaloneApiConfig(api));
}

/**
 * 按「自动重试」开关裁剪候选：关掉时只留第一条，失败就直接报错，不再往后找。
 */
function limitApiCandidates<T>(candidates: T[], autoRetry: boolean | undefined): T[] {
  return autoRetry === false ? candidates.slice(0, 1) : candidates;
}

export function buildMainTurnPrompt(input: StandaloneLocalTurnInput): StandalonePromptMessagesBundle {
  const includeFullPreset = true;
  const localContentBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap: input.localContentEnabledMap,
    builtinRouteOverrides: input.localContentBuiltinRouteOverrides,
    customEntries: input.localContentCustomEntries,
    preset: input.selectedPreset,
    renderContext: {
      statData: input.statData,
      messages: input.messages,
      latestUserMessage: input.latestUserMessage,
      worldDifficulty: input.worldDifficulty,
    },
  });
  const shouldIncludeLotteryRules = input.scriptedTurn?.kind === 'lottery';
  const effectiveLocalContentBlocks = shouldIncludeLotteryRules
    ? localContentBlocks
    : localContentBlocks.filter(block => !block.startsWith(LOTTERY_LOCAL_CONTENT_BLOCK_PREFIX));

  return {
    messages: buildStandaloneOrderedMainMessages({
      statData: input.statData,
      messages: input.messages,
      latestUserMessage: input.latestUserMessage,
      localContentBlocks: effectiveLocalContentBlocks,
      includeFullPreset,
      stageSummary: input.stageSummary,
      archivedUntilMessageId: input.archivedUntilMessageId,
    }),
  };
}

export function inspectStandaloneMainChainView(): StandaloneMainChainView {
  const orderedPrompts = resolveOrderedStandalonePresetPrompts();
  const mainPrompt = orderedPrompts.find(
    prompt => prompt.enabledInOrder && typeof prompt.identifier === 'string' && prompt.identifier === 'main',
  );

  return {
    mode: 'full',
    rawPresetReferenceIdentifier: mainPrompt?.identifier?.trim() || 'main',
    rawPresetReferenceName: mainPrompt?.name?.trim() || 'main',
    entries: [
      {
        key: 'system_protocol',
        orderIndex: 0,
        role: 'system',
      },
      {
        key: 'current_stat_snapshot',
        orderIndex: 1,
        role: 'user',
      },
      {
        key: 'active_worldbook',
        orderIndex: 2,
        role: 'user',
      },
      {
        key: 'recent_history',
        orderIndex: 3,
        role: 'user',
      },
      {
        key: 'latest_user_input',
        orderIndex: 4,
        role: 'user',
      },
    ],
  };
}

export function buildVariableUpdateSecondPassPrompt(input: {
  statData: StandaloneStatData;
  latestUserMessage: MessageRecord;
  assistantContentText: string;
  messages: MessageRecord[];
  worldDifficulty: WorldDifficulty;
  localContentEnabledMap: Record<string, boolean>;
  localContentBuiltinRouteOverrides: StandaloneBuiltinAssetRouteOverrideMap;
  /** 玩家在设置里手动添加的条目；没选预设时靠它把内容送进提示词 */
  localContentCustomEntries?: LocalContentEntryConfig[];
  selectedPreset?: PresetConfig | null;
  /** 纠错重试时携带的上一轮失败回执；首次请求为空 */
  applyRetryFeedback?: VariableUpdateApplyRetryFeedback | null;
}): StandalonePromptMessagesBundle {
  const promptSections = buildStandaloneVariableUpdatePromptSections(input);
  return {
    messages: [
      {
        role: 'user',
        content: promptSections.variableSnapshotPrompt,
      },
      ...(promptSections.wbPrompt
        ? [
            {
              role: 'user' as const,
              content: promptSections.wbPrompt,
            },
          ]
        : []),
      {
        role: 'assistant',
        content: promptSections.assistantContentPrompt,
      },
      ...(promptSections.previousUserPrompt
        ? [
            {
              role: 'user' as const,
              content: promptSections.previousUserPrompt,
            },
          ]
        : []),
      {
        role: 'system',
        content: promptSections.metaSystemPrompt,
      },
      {
        role: 'user',
        content: promptSections.mvuUpdatePrompt,
      },
    ],
  };
}

function buildStandaloneVariableUpdatePromptSections(input: {
  statData: StandaloneStatData;
  latestUserMessage: MessageRecord;
  assistantContentText: string;
  messages: MessageRecord[];
  worldDifficulty: WorldDifficulty;
  localContentEnabledMap: Record<string, boolean>;
  localContentBuiltinRouteOverrides: StandaloneBuiltinAssetRouteOverrideMap;
  /** 玩家在设置里手动添加的条目；没选预设时靠它把内容送进提示词 */
  localContentCustomEntries?: LocalContentEntryConfig[];
  selectedPreset?: PresetConfig | null;
  /** 纠错重试时携带的上一轮失败回执；首次请求为空 */
  applyRetryFeedback?: VariableUpdateApplyRetryFeedback | null;
}): StandaloneVariableUpdatePromptSections {
  const renderContext = {
    statData: input.statData,
    messages: input.messages,
    latestUserMessage: input.latestUserMessage,
    worldDifficulty: input.worldDifficulty,
  };

  const manifest = resolveStandaloneLocalContentEntries({
    preset: input.selectedPreset ?? null,
    enabledMap: input.localContentEnabledMap,
    builtinRouteOverrides: input.localContentBuiltinRouteOverrides,
    customEntries: input.localContentCustomEntries,
  });

  const renderedBlocks = manifest
    .filter(asset => asset.enabled && (asset.route === 'variable_update' || asset.route === 'shared'))
    .map(asset => {
      const renderedContent = renderResolvedStandaloneLocalContentEntry({
        entry: asset,
        renderContext,
      });
      return {
        asset,
        block: renderedContent ? `[本地内容:${asset.title}]\n${renderedContent}` : '',
      };
    })
    .filter(item => item.block.trim());

  const wbPrompt = renderedBlocks
    .filter(item => item.asset.kind === 'worldbook')
    .map(item => item.block)
    .join('\n\n');

  const mvuUpdatePrompt = renderedBlocks
    .filter(item => item.asset.kind === 'variable_update_rule')
    .map(item => item.block)
    .join('\n\n');

  const variableSnapshotPrompt = buildStandaloneCurrentStatDataBlock(input.statData);
  const previousUserPrompt = input.latestUserMessage.content_text.trim() || input.latestUserMessage.raw_content.trim();
  const assistantContentPrompt = input.assistantContentText.trim();
  // Fix 4：当商城刷新被触发时，在元指令顶部注入最高优先级任务，避免刷新要求被埋没在
  // mvuUpdatePrompt 中段而被模型忽略（表现为“商城无刷新内容”）。
  const shopRefreshTriggered = Boolean(
    (input.statData as { 设置?: { 积分系统?: { 商城刷新?: unknown } } })?.设置?.积分系统?.商城刷新,
  );
  const shopRefreshDirective = shopRefreshTriggered
    ? normalizeLineEndings(`
[最高优先级任务 · 商城刷新]
玩家已请求刷新商城，本次变量更新必须刷新商城商品。
硬性要求：
- 必须在 <JSONPatch> 中用 replace 覆盖 "/商城/物品" 与 "/商城/技能"，生成与现有完全不同的商品。
- 品质分布参考：普通40%、精良30%、稀有20%、史诗7%、传说3%。
- 价格参考：普通10-50、精良50-150、稀有150-500、史诗500-2000、传说2000-10000。
- 建议生成 4 个物品 + 4 个技能；稀有及以上品质的技能均为超能力。
- 详细字段结构见下方变量更新规则中的“商城刷新任务”。
- 不要输出空的 <JSONPatch>；本回合至少包含上述商城刷新补丁。
`)
    : '';
  // 纠错重试回执：上一轮补丁拿到了块、但逐条应用失败。必须放在元指令最顶部，
  // 让模型先看到失败原因与原补丁，再重新输出修正后的整份补丁。
  const applyRetryFeedback = input.applyRetryFeedback ?? null;
  const applyRetryDirective = applyRetryFeedback
    ? normalizeLineEndings(`
[最高优先级任务 · 补丁纠错重试]
你上一次输出的变量更新补丁在应用时失败，本次必须修正后重新输出。
失败原因：${applyRetryFeedback.errorMessage}
上一次的补丁内容：
${applyRetryFeedback.failedPatchText ?? '（无法提取，请参照失败原因自查）'}
硬性要求：
- 参照最上方 [当前变量快照 stat_data] 逐字核对每个 path：replace/delta/remove 的目标必须真实存在，新建条目必须用 insert，路径中的对象键要逐字复制快照里已有的键。
- 本次仍然输出完整的一份 <UpdateVariable>（一个 <Analysis> + 一个 <JSONPatch>），不要只输出 diff 或解释。
`)
    : '';
  const metaSystemPrompt = normalizeLineEndings(`
[Meta.System]
[元命令]
停止角色扮演
不要输出剧情
上文中的剧情是最新,但变量是该剧情发生之前的状态
按照变量输出格式中的要求,在本次回复中更新变量
${applyRetryDirective ? `\n${applyRetryDirective}\n` : ''}${shopRefreshDirective ? `\n${shopRefreshDirective}\n` : ''}
硬性要求：
1. 只输出且必须输出一个 <UpdateVariable> 块。
2. <UpdateVariable> 内必须有且只有一个 <Analysis> 和一个 <JSONPatch>。
3. 不要输出 <contenttext>、<summary>、<action_options>、Markdown 代码块或其他文字。
4. 如果没有需要更新的变量，就在 <JSONPatch> 中输出 []。${
    shopRefreshTriggered ? '\n5. 例外：本回合商城刷新已触发，<JSONPatch> 不得为空，必须包含商城刷新补丁。' : ''
  }
`);

  return {
    variableSnapshotPrompt,
    wbPrompt,
    previousUserPrompt,
    assistantContentPrompt,
    metaSystemPrompt,
    mvuUpdatePrompt,
  };
}

async function requestAssistantReply(
  api: ApiConfig,
  prompt: StandalonePromptBundle | StandalonePromptMessagesBundle,
  signal: AbortSignal,
  onPartialText?: (text: string) => void,
): Promise<StandaloneProviderReply> {
  return requestStandaloneProviderText({
    api,
    prompt,
    signal,
    logPrefix: '[StandaloneLocalTurn]',
    onPartialText,
  });
}

function applyVariableUpdateFromReply(
  currentStatData: StandaloneStatData,
  rawReply: string,
): VariableUpdateApplyResult {
  const parsedReply = parseTaggedAssistantReply(rawReply);
  const patchText = parsedReply.updateJsonPatchText;

  if (!patchText) {
    return {
      parsedReply,
      nextStatData: currentStatData,
      variableUpdateApplied: false,
      errorMessage: null,
    };
  }

  try {
    const parsedPatch = parseVariableUpdatePatch(patchText);
    const nextStatData = applyVariableUpdatePatch(currentStatData, parsedPatch.patch);

    return {
      parsedReply,
      nextStatData,
      variableUpdateApplied: parsedPatch.patch.length > 0,
      errorMessage: null,
    };
  } catch (error) {
    return {
      parsedReply,
      nextStatData: currentStatData,
      variableUpdateApplied: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractUpdateVariableBlock(text: string): string | null {
  const match = text.match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
  return match?.[0]?.trim() ?? null;
}

/** 从已拿到的 <UpdateVariable> 块里提取 <JSONPatch> 原文，供纠错回执展示；提取不到返回 null。 */
function extractJsonPatchTextFromUpdateBlock(updateBlock: string): string | null {
  const match = updateBlock.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i);
  return match?.[1]?.trim() ?? null;
}

function stripUpdateVariableBlocks(text: string): string {
  return text.replace(/\s*<UpdateVariable>[\s\S]*?<\/UpdateVariable>\s*/gi, '\n').trim();
}

function buildAssistantMessagePayload(
  parsedReply: ParsedTaggedAssistantReply,
  rawContent: string,
  debugTrace?: StandaloneAssistantDebugTrace,
  model?: string,
) {
  const contentText = parsedReply.contentText.trim() || parsedReply.fallbackContentText.trim() || rawContent.trim();
  const createdAt = new Date().toISOString();

  return {
    role: 'assistant' as const,
    raw_content: rawContent,
    content_text: contentText,
    think_content: parsedReply.thinkContent,
    summary_content: parsedReply.summaryContent,
    update_content: parsedReply.updateContent,
    action_options: parsedReply.actionOptions,
    formatted: formatMessageContentForDisplay(contentText, 'assistant', -1),
    createdAt,
    variable_update_warning: null,
    debug_trace: debugTrace,
    model,
  };
}

async function requestVariableUpdateSecondPass(
  input: StandaloneLocalTurnInput,
  assistantContentText: string,
  signal: AbortSignal,
  applyRetryFeedback: VariableUpdateApplyRetryFeedback | null = null,
): Promise<VariableUpdateSecondPassResult> {
  const secondPassPrompt = buildVariableUpdateSecondPassPrompt({
    statData: input.statData,
    latestUserMessage: input.latestUserMessage,
    assistantContentText,
    messages: input.messages,
    worldDifficulty: input.worldDifficulty,
    localContentEnabledMap: input.localContentEnabledMap,
    localContentBuiltinRouteOverrides: input.localContentBuiltinRouteOverrides,
    localContentCustomEntries: input.localContentCustomEntries,
    selectedPreset: input.selectedPreset ?? null,
    applyRetryFeedback,
  });

  const candidateApis = limitApiCandidates(resolveConfiguredAssistantApis(input.assistantApis), input.autoRetry);

  if (candidateApis.length === 0) {
    return {
      updateBlock: null,
      warning: '未找到已保存且完整可用的辅助 API 配置，无法补写变量更新',
      usedApiLabel: null,
    };
  }

  const failures: string[] = [];

  for (const api of candidateApis) {
    const apiLabel = toApiLabel(api);

    try {
      const secondPassReply = await requestAssistantReply(api, secondPassPrompt, signal);
      const normalizedSecondPassReply = normalizeLineEndings(secondPassReply.text);
      const updateBlock = extractUpdateVariableBlock(normalizedSecondPassReply);

      if (!updateBlock) {
        failures.push(`${apiLabel}: 未返回合法的 <UpdateVariable> 块`);
        continue;
      }

      return {
        updateBlock,
        warning: null,
        usedApiLabel: apiLabel,
        debugTrace: secondPassReply.debugTrace,
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      failures.push(`${apiLabel}: ${normalizeRemoteApiErrorMessage(error)}`);
    }
  }

  return {
    updateBlock: null,
    warning: failures.join(' | ') || '变量更新补写失败',
    usedApiLabel: null,
  };
}

async function requestVariableUpdateSecondPassWithTimeout(
  input: StandaloneLocalTurnInput,
  assistantContentText: string,
  signal: AbortSignal,
  applyRetryFeedback: VariableUpdateApplyRetryFeedback | null = null,
): Promise<VariableUpdateSecondPassResult> {
  const timedSignal = createTimedAbortSignal({
    parentSignal: signal,
    timeoutMs: STANDALONE_VARIABLE_UPDATE_TIMEOUT_MS,
    timeoutMessage: STANDALONE_VARIABLE_UPDATE_TIMEOUT_ERROR_MESSAGE,
  });

  try {
    return await requestVariableUpdateSecondPass(
      input,
      assistantContentText,
      timedSignal.signal,
      applyRetryFeedback,
    );
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    if (timedSignal.didTimeout()) {
      throw timedSignal.timeoutError;
    }

    throw error;
  } finally {
    timedSignal.cleanup();
  }
}

export function cancelStandaloneLocalTurn(): void {
  activeStandaloneTurnController?.abort();
}

/**
 * 执行二段变量更新并把补丁应用到基线状态上，共享于两条链路：
 * 正常回合收尾（finalizeVariableUpdate）与手动刷新（runStandaloneVariableUpdatePass）。
 *
 * 「拿到了 <UpdateVariable> 块、但逐条应用失败」时（典型：AI 引用了快照里不存在的路径，
 * 如待办条目标题对不上），携带失败原因与原补丁向辅助 API 纠错重试一次；重试仍失败则
 * 维持原有的「整批作废 + 警告」语义，不掩盖真正的路径错误。
 */
async function runSecondPassVariableUpdateWithApplyRetry(input: {
  turnInput: StandaloneLocalTurnInput;
  /** 已剥掉旧 <UpdateVariable> 块的正文原文；每轮补丁块都会拼回它上面再整体解析应用 */
  baseRawReply: string;
  signal: AbortSignal;
  /** 逐条应用补丁的基线状态（重试请求也用它拼快照，保证 AI 看到的与最终应用的一致） */
  baseStatData: StandaloneStatData;
}): Promise<{
  /** 成功应用的补丁结果；null 表示本回合未应用（块缺失/应用失败/空补丁） */
  applyResult: VariableUpdateApplyResult | null;
  /** 正文 + 本轮补丁块拼回后的完整回复原文；未应用时为 null */
  effectiveRawReply: string | null;
  warning: string | null;
  status: Exclude<StandaloneVariableUpdateStatus, 'running'>;
  variableUpdateApiLabel: string | null;
  debugTrace: StandaloneAssistantDebugTrace | undefined;
}> {
  const { turnInput, baseRawReply, signal, baseStatData } = input;
  const assistantContentText = parseTaggedAssistantReply(baseRawReply).contentText.trim();

  let variableUpdateApiLabel: string | null = null;
  let debugTrace: StandaloneAssistantDebugTrace | undefined;
  let currentApplyRetryFeedback: VariableUpdateApplyRetryFeedback | null = null;

  for (let attempt = 0; ; attempt += 1) {
    const secondPassResult = await requestVariableUpdateSecondPassWithTimeout(
      {
        ...turnInput,
        statData: baseStatData,
      },
      assistantContentText,
      signal,
      currentApplyRetryFeedback,
    );
    variableUpdateApiLabel = secondPassResult.usedApiLabel;
    if (secondPassResult.debugTrace) {
      debugTrace = mergeStandaloneAssistantDebugTrace(debugTrace, {
        variable_update_pass: secondPassResult.debugTrace,
      });
    }

    if (!secondPassResult.updateBlock) {
      return {
        applyResult: null,
        effectiveRawReply: null,
        warning: secondPassResult.warning ?? '补写变量更新失败',
        status: secondPassResult.warning ? 'failed' : 'skipped',
        variableUpdateApiLabel,
        debugTrace,
      };
    }

    const mergedRawReply = replaceOrAppendUpdateVariableBlock(baseRawReply, secondPassResult.updateBlock);
    const mergedApplyResult = applyVariableUpdateFromReply(baseStatData, mergedRawReply);

    if (!mergedApplyResult.errorMessage) {
      return {
        applyResult: mergedApplyResult,
        effectiveRawReply: mergedRawReply,
        warning: null,
        status: mergedApplyResult.variableUpdateApplied ? 'success' : 'skipped',
        variableUpdateApiLabel,
        debugTrace,
      };
    }

    if (attempt >= STANDALONE_VARIABLE_UPDATE_APPLY_RETRY_LIMIT) {
      return {
        applyResult: null,
        effectiveRawReply: null,
        warning: mergedApplyResult.errorMessage,
        status: 'failed',
        variableUpdateApiLabel,
        debugTrace,
      };
    }

    // 本轮应用失败但还有重试额度：把失败原因与原补丁打包成纠错回执，供下一轮请求注入提示词。
    currentApplyRetryFeedback = {
      errorMessage: mergedApplyResult.errorMessage,
      failedPatchText: extractJsonPatchTextFromUpdateBlock(secondPassResult.updateBlock),
    };
    console.warn(
      `[StandaloneLocalTurn] 变量更新补丁应用失败，将携带错误回执重试（第 ${attempt + 1} 次）：`,
      mergedApplyResult.errorMessage,
    );
  }
}

export async function runStandaloneLocalTurn(input: StandaloneLocalTurnInput): Promise<StandaloneLocalTurnOutcome> {
  const candidateMainApis = limitApiCandidates(resolveConfiguredMainApis(input.mainApis), input.autoRetry);
  if (candidateMainApis.length === 0) {
    throw new Error('未找到已保存且完整可用的 API 配置');
  }

  if (activeStandaloneTurnController) {
    throw new Error('已有独立模式生成任务正在进行中');
  }

  const controller = new AbortController();
  activeStandaloneTurnController = controller;
  let deferControllerCleanup = false;

  try {
    const prompt = buildMainTurnPrompt(input);
    const failures: string[] = [];
    let lastErrorMessage = '';

    // 主 API 可以有多个候选：第一个失败就换下一个；关掉自动重试时只剩一个
    for (let index = 0; index < candidateMainApis.length; index += 1) {
      const candidateApi = candidateMainApis[index]!;
      const candidateApiLabel = toApiLabel(candidateApi);

      try {
        const mainReply = await requestAssistantReply(
          candidateApi,
          prompt,
          controller.signal,
          input.onMainReplyPartialText,
        );
        const rawReply = normalizeLineEndings(mainReply.text);
        const sanitizedMainReply = normalizeLineEndings(stripUpdateVariableBlocks(rawReply));

        const mainReplyApplyResult = applyVariableUpdateFromReply(input.statData, sanitizedMainReply);
        const mainDebugTrace = mergeStandaloneAssistantDebugTrace(undefined, {
          main_pass: {
            ...mainReply.debugTrace,
            extracted_text: sanitizedMainReply,
          },
        });
        const assistantMessage = buildAssistantMessagePayload(
          mainReplyApplyResult.parsedReply,
          sanitizedMainReply,
          mainDebugTrace,
          mainReply.model,
        );
        const assistantContentText = mainReplyApplyResult.parsedReply.contentText.trim() || sanitizedMainReply;
        if (!assistantContentText.trim()) {
          throw new Error('主 API 未返回正文内容，请检查模型是否按要求输出 <contenttext> 正文块');
        }

        deferControllerCleanup = true;

        const finalizeVariableUpdate = (async (): Promise<StandaloneVariableUpdatePhaseOutcome> => {
          await new Promise<void>(resolve => setTimeout(resolve, 0));

          let applyResult = mainReplyApplyResult;
          let effectiveRawReply = sanitizedMainReply;
          let variableUpdateWarning: string | null = null;
          let variableUpdateApiLabel: string | null = null;
          let variableUpdateStatus: StandaloneVariableUpdateStatus = 'running';
          let debugTrace = mainDebugTrace;

          try {
            const secondPassOutcome = await runSecondPassVariableUpdateWithApplyRetry({
              turnInput: input,
              baseRawReply: sanitizedMainReply,
              signal: controller.signal,
              baseStatData: input.statData,
            });
            variableUpdateApiLabel = secondPassOutcome.variableUpdateApiLabel;
            debugTrace = mergeStandaloneAssistantDebugTrace(debugTrace, {
              variable_update_pass: secondPassOutcome.debugTrace?.variable_update_pass,
            });

            if (secondPassOutcome.applyResult) {
              applyResult = secondPassOutcome.applyResult;
              effectiveRawReply = secondPassOutcome.effectiveRawReply ?? sanitizedMainReply;
              variableUpdateWarning = null;
              variableUpdateStatus = secondPassOutcome.status;
            } else {
              variableUpdateWarning = secondPassOutcome.warning;
              variableUpdateStatus = secondPassOutcome.status;
            }
          } catch (error) {
            if (controller.signal.aborted) {
              throw error;
            }

            variableUpdateWarning = error instanceof Error ? error.message : String(error);
            variableUpdateStatus = 'failed';
          }

          const usedApiLabel =
            variableUpdateApiLabel && variableUpdateApiLabel !== candidateApiLabel
              ? `${candidateApiLabel} + ${variableUpdateApiLabel}`
              : candidateApiLabel;

          return {
            assistantMessage: {
              ...buildAssistantMessagePayload(applyResult.parsedReply, effectiveRawReply, debugTrace, mainReply.model),
              variable_update_status: variableUpdateStatus,
              variable_update_warning: variableUpdateWarning,
            },
            nextStatData: applyResult.nextStatData,
            variableUpdateApplied: applyResult.variableUpdateApplied,
            variableUpdateWarning,
            variableUpdateStatus,
            usedApiLabel,
          };
        })().finally(() => {
          if (activeStandaloneTurnController === controller) {
            activeStandaloneTurnController = null;
          }
        });

        return {
          assistantMessage: {
            ...assistantMessage,
            variable_update_status: 'running',
            variable_update_warning: null,
          },
          usedApiLabel: candidateApiLabel,
          finalizeVariableUpdate,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error('standalone_local_turn_aborted');
        }

        const message = normalizeRemoteApiErrorMessage(error);
        lastErrorMessage = message;
        failures.push(`${candidateApiLabel}: ${message}`);

        console.warn('[StandaloneLocalTurn] 主 API 调用失败:', {
          source: candidateApi.source,
          model: candidateApi.model,
          message,
          attempt: index + 1,
          totalAttempts: candidateMainApis.length,
        });
      }
    }

    throw new Error(failures.length > 1 ? failures.join(' | ') : lastErrorMessage || '独立模式主 API 调用失败');
  } finally {
    if (!deferControllerCleanup && activeStandaloneTurnController === controller) {
      activeStandaloneTurnController = null;
    }
  }
}
