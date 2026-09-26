import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { plotLotteryRulesTemplate, variableUpdateRulesTemplate } from '../../src/assets/standalone-local-content';
import { legacyWorldbookContentByName } from '../../src/assets/legacy-worldbook-compat';
import { getBuiltInPresets, isWorkshopPreset } from '../../src/utils/preset-groups';
import {
  formatArchiveSummaryForToast,
  clearPendingStandaloneArchiveResume,
  getStandaloneArchiveFeedbackMessageKey,
  importArchiveFile,
  listStandaloneArchives,
  loadPendingStandaloneArchiveResume,
  pruneStandaloneArchiveDebugTraces,
  restoreStandaloneArchiveById,
  saveStandaloneArchiveSnapshot,
  type StandaloneArchiveFile,
} from '../../src/utils/archive';
import {
  renderStandaloneLocalContentTemplate,
  type StandaloneLocalContentRenderContext,
} from '../../src/utils/standaloneLocalContentEjs';
import { useMessagesStore, type MessageRecord } from '../../src/stores/messages';
import { parseTaggedAssistantReply } from '../../src/utils/taggedReply';
import {
  applyOnlineModeToStandaloneLocalContent,
  applyTextToImageToStandaloneLocalContent,
  applyFixedVariableUpdateStandaloneLocalContent,
  buildWorldDifficultyStandaloneLocalContent,
  getStandaloneLocalContentBuiltinRouteOverrides,
  getStandaloneLocalContentManifest,
  inferStandaloneLocalContentKind,
  normalizeLocalContentEntriesInput,
  resolveStandaloneLocalContentEntries,
  resolveStandaloneLocalContentBlocks,
} from '../../src/utils/standaloneLocalContent';
import { migrateLegacyPresetLocalContent } from '../../src/utils/legacyPresetCompat';
import { capuaBloodSandPresets } from '../../src/presets/capua-blood-sand';
import type { PresetConfig } from '../../src/presets/types';
import {
  buildMainTurnPrompt,
  cancelStandaloneLocalTurn,
  buildVariableUpdateSecondPassPrompt,
  collectStandalonePriorSummaryItems,
  runStandaloneLocalTurn,
  type StandaloneLocalTurnInput,
} from '../../src/utils/standaloneLocalTurn';
import { cancelStandaloneMainApiRequest, requestStandaloneMainApiText } from '../../src/utils/standaloneMainApi';
import {
  hasCompleteStandaloneProviderApiConfig,
  requestStandaloneProviderTextCore,
} from '../../runtime/standaloneProviderCore';
import { fetchOpenAiCompatibleModelIds } from '../../src/utils/openAiCompatibleModels';
import {
  applyStandalonePromptMacroReplacements,
  applyStandaloneTavernMacroState,
  buildStandaloneCurrentStatDataBlock,
  createStandaloneTavernMacroState,
} from '../../runtime/standalonePromptUtils';
import {
  attachRegisteredWorldbooksToBuiltInPresets,
  createRegisteredWorldbookLocalContentEntries,
  rehydratePresetWithRegisteredWorldbooks,
  registeredWorldbookAssets,
  registeredWorldbookContentByName,
} from '../../src/assets/worldbook-registry';
import {
  resolveMainPassWorldbookPromptFromTrace,
  resolvePreferredVariableDebugPass,
} from '../../src/utils/standaloneAiDebug';
import { formatAuxiliaryContentForDisplay, formatMessageContentForDisplay } from '../../src/utils/messageFormatting';
import {
  createDefaultApiConfig,
  normalizeApiConfig,
  normalizeStandaloneOpenAiApiUrl,
  normalizeStandaloneOpenAiChatCompletionsApiUrl,
  normalizeStandaloneOpenAiModelsApiUrl,
  useSettingsStore,
  resolveStoredStandaloneLocalContentSettings,
} from '../../src/stores/settings';
import { getPresets, loadPresetsBundle } from '../../src/utils/preset-loader';
import { useNotificationStore } from '../../src/stores/notification';
import { useSetupStore } from '../../src/stores/setup';
import { useMessageActions } from '../../src/composables/useMessageActions';
import { useStatDataStore } from '../../src/stores/statData';
import {
  createSeededStandaloneRuntimeSession,
  loadStandaloneRuntimeMessages,
  clearStandaloneRuntimeState,
  ensureStandaloneRuntimeBootstrap,
  getStandaloneRuntimeContentContext,
  loadStandaloneRuntimeSession,
  patchStandaloneRuntimeSessionContext,
  persistStandaloneRuntimeSession,
  syncStandaloneRuntimeSessionStatData,
} from '../../src/utils/standaloneRuntime';
import { clearStandaloneStatData, loadStandaloneStatData } from '../../src/utils/standaloneStatData';
import {
  archiveStandaloneStageSummary,
  resolveStandaloneStageSummaryProgress,
} from '../../src/utils/stageSummaryArchive';
import { DEFAULT_STAGE_SUMMARY_THRESHOLD, normalizeStageSummaryThreshold } from '../../src/utils/stageSummaryThreshold';
import {
  loadStandaloneTavernPresetLibrary,
  pruneStandaloneTavernPresetLibraryOversizedFields,
  saveImportedStandaloneTavernPreset,
  type StandaloneTavernPresetDocument,
} from '../../src/utils/standaloneTavernPreset';

const STANDALONE_ARCHIVE_STORAGE_KEY_PREFIX = 'th1980s:standalone-archive:';
// 预设记忆是「跟着会话走」的：键 = th1980s:selected-preset:<会话id>。
// 没有会话时读取路径直接返回 null，所以测这条必须先把会话造出来。
const STANDALONE_SELECTED_PRESET_STORAGE_KEY_PREFIX = 'th1980s:selected-preset';
const mockEventBus = new Map<string, Array<(payload: unknown) => void>>();

const browserDocument = {
  documentElement: {
    lang: 'zh-CN',
  },
  body: {
    appendChild() {},
    removeChild() {},
  },
  createElement(tagName: string) {
    if (tagName === 'a') {
      return {
        href: '',
        download: '',
        click() {},
      };
    }

    return {
      tagName,
    };
  },
  querySelector() {
    return null;
  },
};

const browserWindow = {
  document: browserDocument,
  parent: {
    document: {
      querySelector() {
        return null;
      },
    },
  },
  location: {
    reload() {
      reloadCallCount += 1;
    },
  },
  dispatchEvent() {
    return true;
  },
  setTimeout,
  clearTimeout,
  frameElement: null,
  innerWidth: 1280,
};

let reloadCallCount = 0;

function getStandaloneTestSchema() {
  return (require('../../schema/schema.ts') as typeof import('../../schema/schema')).Schema;
}

if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: browserWindow,
    configurable: true,
  });
}

if (typeof globalThis.document === 'undefined') {
  Object.defineProperty(globalThis, 'document', {
    value: browserDocument,
    configurable: true,
  });
}

if (typeof globalThis.File === 'undefined') {
  class MockFile extends Blob {
    name: string;
    lastModified: number;

    constructor(parts: BlobPart[], fileName: string, options?: BlobPropertyBag) {
      super(parts, options);
      this.name = fileName;
      this.lastModified = Date.now();
    }
  }

  Object.defineProperty(globalThis, 'File', {
    value: MockFile,
    configurable: true,
  });
}

Object.defineProperty(globalThis, 'toastr', {
  value: {
    success() {},
    error() {},
    warning() {},
    info() {},
  },
  configurable: true,
});

function createMemoryStorage() {
  const storage = new Map<string, string>();
  return {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  value: createMemoryStorage(),
  configurable: true,
});

Object.defineProperty(globalThis, 'eventOn', {
  value: (eventName: string, handler: (payload: unknown) => void) => {
    const handlers = mockEventBus.get(eventName) ?? [];
    handlers.push(handler);
    mockEventBus.set(eventName, handlers);
    return {
      stop() {
        const currentHandlers = mockEventBus.get(eventName) ?? [];
        mockEventBus.set(
          eventName,
          currentHandlers.filter(item => item !== handler),
        );
      },
    };
  },
  configurable: true,
});

Object.defineProperty(globalThis, 'eventEmit', {
  value: (eventName: string, payload: unknown) => {
    const handlers = mockEventBus.get(eventName) ?? [];
    handlers.forEach(handler => handler(payload));
    return true;
  },
  configurable: true,
});

function resetStandaloneTestEnvironment() {
  reloadCallCount = 0;
  mockEventBus.clear();
  localStorage.clear();
  clearPendingStandaloneArchiveResume();
  clearStandaloneRuntimeState();
  clearStandaloneStatData();
  setActivePinia(createPinia());
}

function createMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    message_id: 1,
    role: 'user',
    raw_content: '测试输入',
    content_text: '测试输入',
    formatted: '测试输入',
    action_options: [],
    ...overrides,
  };
}

function createRenderContext(
  overrides: Partial<StandaloneLocalContentRenderContext> = {},
): StandaloneLocalContentRenderContext {
  const statData = {
    设置: {
      生存系统模式: '生存模式',
      积分系统: {
        抽奖次数: 1,
        保底触发: true,
      },
    },
    玩家: {
      姓名: '测试玩家',
    },
    人物档案: {
      NPC_1: {
        姓名: '老周',
        _关注: true,
      },
      NPC_2: {
        姓名: '路人甲',
        重要NPC: true,
      },
    },
  };

  return {
    statData,
    messages: [createMessage()],
    latestUserMessage: createMessage(),
    worldDifficulty: '最简单',
    ...overrides,
  };
}

function createMockFetchResponse(input: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  jsonData?: unknown;
  textData?: string;
}): Response {
  const resolvedTextData =
    typeof input.textData === 'string'
      ? input.textData
      : typeof input.jsonData === 'undefined'
        ? ''
        : JSON.stringify(input.jsonData);

  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    statusText: input.statusText ?? 'OK',
    async json() {
      return input.jsonData;
    },
    async text() {
      return resolvedTextData;
    },
  } as Response;
}

function createMockStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    async text() {
      return chunks.join('');
    },
  } as Response;
}

function isStandaloneVariableUpdateRequest(body: any): boolean {
  if (!Array.isArray(body?.messages)) {
    return false;
  }

  const messages = body.messages as Array<{ role?: string; content?: string }>;
  const hasAssistantContent = messages.some(item => item?.role === 'assistant' && typeof item.content === 'string');
  const hasMetaSystem = messages.some(
    item => item?.role === 'system' && typeof item.content === 'string' && item.content.includes('[Meta.System]'),
  );
  const lastMessage = messages[messages.length - 1];

  return Boolean(
    hasAssistantContent &&
    hasMetaSystem &&
    lastMessage?.role === 'user' &&
    typeof lastMessage.content === 'string' &&
    lastMessage.content.includes('[本地内容:变量输出格式]'),
  );
}

async function flushScheduledUiEffects(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await nextTick();
  }
}

async function testPassesThroughPlainText(): Promise<void> {
  const result = renderStandaloneLocalContentTemplate({
    template: '纯文本规则，不需要模板。',
    renderContext: createRenderContext(),
    sourceName: 'plain.txt',
  });

  assert.equal(result.content, '纯文本规则，不需要模板。');
  assert.equal(result.warning, null);
}

function testStandaloneMessageFormattingSupportsRichText(): void {
  const formatted = formatMessageContentForDisplay(
    '# 标题\n\n**加粗** 与 *斜体*\n\n- 条目一\n- 条目二\n\n`代码`',
    'assistant',
    7,
  );

  assert.match(formatted, /<h1>标题<\/h1>/);
  assert.match(formatted, /<strong>加粗<\/strong>/);
  assert.match(formatted, /<em>斜体<\/em>/);
  assert.match(formatted, /<ul><li>条目一<\/li><li>条目二<\/li><\/ul>/);
  assert.match(formatted, /<code>代码<\/code>/);
}

function testStandaloneAuxiliaryFormattingSupportsRichText(): void {
  const formatted = formatAuxiliaryContentForDisplay('> 引用\n\n1. 第一步\n2. 第二步', 8);

  assert.match(formatted, /<blockquote>引用<\/blockquote>/);
  assert.match(formatted, /<ol><li>第一步<\/li><li>第二步<\/li><\/ol>/);
}

function testStandaloneMessageFormattingHighlightsDialogueQuotes(): void {
  const formatted = formatMessageContentForDisplay('“路哥。”她没抬头。\n\n“嗯。”', 'assistant', 9);

  assert.match(formatted, /<span class="quote">“路哥。"?[^<]*?/);
  assert.match(formatted, /<span class="quote">“嗯。”<\/span>/);
}

async function testSupportsRawInterpolationWithoutHtmlEscaping(): Promise<void> {
  const result = renderStandaloneLocalContentTemplate({
    template: '<%= "<contenttext>保留原样</contenttext>" %>',
    renderContext: createRenderContext(),
    sourceName: 'raw-output.txt',
  });

  assert.equal(result.content, '<contenttext>保留原样</contenttext>');
  assert.equal(result.warning, null);
}

async function testSupportsGetvarDefaultsAndLodashRandom(): Promise<void> {
  const result = renderStandaloneLocalContentTemplate({
    template: 'missing=<%= getvar("stat_data.不存在", { defaults: "默认值" }) %>; rand=<%= _.random(2, 2) %>',
    renderContext: createRenderContext(),
    sourceName: 'helpers.txt',
  });

  assert.equal(result.content, 'missing=默认值; rand=2');
  assert.equal(result.warning, null);
}

function testStandalonePromptMacroReplacementHelpers(): void {
  const statData = createRenderContext().statData;
  const replaced = applyStandalonePromptMacroReplacements(
    'snapshot={{format_message_variable::stat_data}}; user={{user}}; char={{char}}; scenario={{scenario}}',
    { statData },
  );

  assert.match(replaced, /"姓名": "测试玩家"/);
  assert.match(replaced, /user=测试玩家/);
  assert.match(replaced, /char=当前角色/);
  assert.match(replaced, /scenario=当前场景/);
  assert.equal(buildStandaloneCurrentStatDataBlock(statData).startsWith('[当前变量快照 stat_data]\n{'), true);

  assert.equal(
    applyStandalonePromptMacroReplacements('scenario={{scenario}}', {
      statData: { 世界: { 空间定位: { 当前位置: '王都商业区' } } },
    }),
    'scenario=王都商业区',
  );

  assert.equal(applyStandalonePromptMacroReplacements('user={{user}}', { statData: {} }), 'user=玩家');
}

function testStandaloneTavernMacroState(): void {
  const state = createStandaloneTavernMacroState();
  const first = applyStandaloneTavernMacroState(
    '{{setvar::schema::ROOT}}value={{getvar::schema}}',
    state,
  );
  assert.equal(first, 'value=ROOT');

  const second = applyStandaloneTavernMacroState('{{addvar::schema::-BODY}} {{getvar::schema}}', state);
  assert.equal(second, ' ROOT-BODY');

  assert.equal(applyStandaloneTavernMacroState('{{getvar::missing}}', state), '');
}

function testTaggedReplyFallbackStripsStrayContenttextTags(): void {
  // 场景一：只有开标签没有闭标签（典型截断），标签字面量不能漏进兜底正文
  const unclosed = parseTaggedAssistantReply('<analysis_block>分析</analysis_block>\n<contenttext>\n正文开始');
  assert.equal(unclosed.contentText, '');
  assert.equal(unclosed.fallbackContentText, '正文开始');

  // 场景二：成对但正文提取前其他标签已剥离，成对 contenttext 应保留内部文本
  const paired = parseTaggedAssistantReply('<summary>总结</summary>\n<contenttext>真正的正文</contenttext>');
  assert.equal(paired.fallbackContentText, '真正的正文');

  // 场景三：落单的闭标签也要移除
  const strayClose = parseTaggedAssistantReply('正文写完了\n</contenttext>');
  assert.equal(strayClose.fallbackContentText, '正文写完了');
}

function testPriorSummariesOutsideRecentWindowAreInjected(): void {
  const latestUserMessage = createMessage({ message_id: 21, role: 'user', content_text: '本轮输入' });
  const history: MessageRecord[] = [];

  for (let round = 1; round <= 10; round += 1) {
    history.push(
      createMessage({ message_id: round * 2 - 1, role: 'user', content_text: `第${round}轮输入` }),
      createMessage({
        message_id: round * 2,
        role: 'assistant',
        content_text: `第${round}轮正文`,
        summary_content: `第${round}轮总结`,
      }),
    );
  }

  const combined = buildMainTurnPrompt(
    createStandaloneTurnInput({
      messages: [...history, latestUserMessage],
      latestUserMessage,
    }),
  )
    .messages.map(message => message.content)
    .join('\n\n');

  assert.ok(combined.includes('[前情提要]'));
  assert.ok(combined.includes('第1轮总结'));
  assert.ok(combined.includes('第6轮总结'));
  assert.ok(!combined.includes('第7轮总结'));
  assert.ok(combined.includes('第10轮正文'));

  const withoutSummary = buildMainTurnPrompt(
    createStandaloneTurnInput({ messages: [createMessage()], latestUserMessage: createMessage() }),
  )
    .messages.map(message => message.content)
    .join('\n\n');

  assert.ok(!withoutSummary.includes('[前情提要]'));
}

function testStageSummaryReplacesArchivedPriorSummaries(): void {
  const latestUserMessage = createMessage({ message_id: 21, role: 'user', content_text: '本轮输入' });
  const history: MessageRecord[] = [];

  for (let round = 1; round <= 10; round += 1) {
    history.push(
      createMessage({ message_id: round * 2 - 1, role: 'user', content_text: `第${round}轮输入` }),
      createMessage({
        message_id: round * 2,
        role: 'assistant',
        content_text: `第${round}轮正文`,
        summary_content: `第${round}轮总结`,
      }),
    );
  }

  const messages = [...history, latestUserMessage];
  const combined = buildMainTurnPrompt(
    createStandaloneTurnInput({
      messages,
      latestUserMessage,
      stageSummary: '第1、2轮已归档：主角离开村子抵达王都。',
      archivedUntilMessageId: 4,
    }),
  )
    .messages.map(message => message.content)
    .join('\n\n');

  assert.ok(combined.includes('[阶段总结]'));
  assert.ok(combined.includes('第1、2轮已归档：主角离开村子抵达王都。'));
  // 已被阶段总结覆盖的回合不再逐条重复发
  assert.ok(!combined.includes('第1轮总结'));
  assert.ok(!combined.includes('第2轮总结'));
  // 还没归档的照旧进前情提要
  assert.ok(combined.includes('第3轮总结'));
  assert.ok(combined.includes('第6轮总结'));
  assert.ok(!combined.includes('第7轮总结'));

  // 没有阶段总结时只剩前情提要，旧条目照旧全发
  const withoutStage = buildMainTurnPrompt(createStandaloneTurnInput({ messages, latestUserMessage }))
    .messages.map(message => message.content)
    .join('\n\n');

  assert.ok(!withoutStage.includes('[阶段总结]'));
  assert.ok(withoutStage.includes('第1轮总结'));
}

function testStageSummaryThresholdNormalization(): void {
  assert.equal(DEFAULT_STAGE_SUMMARY_THRESHOLD, 100);
  assert.equal(normalizeStageSummaryThreshold(undefined), 100);
  assert.equal(normalizeStageSummaryThreshold(100), 100);
  assert.equal(normalizeStageSummaryThreshold('200'), 200);
  assert.equal(normalizeStageSummaryThreshold(300), 300);
  assert.equal(normalizeStageSummaryThreshold(500), 500);
  // 不在档位里的值一律回退默认档
  assert.equal(normalizeStageSummaryThreshold(123), 100);
  assert.equal(normalizeStageSummaryThreshold(-5), 100);
  assert.equal(normalizeStageSummaryThreshold(Number.NaN), 100);
  assert.equal(normalizeStageSummaryThreshold('abc'), 100);
}

function testCollectStandalonePriorSummaryItemsSharesWindowWithPrompt(): void {
  const messages: MessageRecord[] = [];

  for (let round = 1; round <= 10; round += 1) {
    messages.push(
      createMessage({ message_id: round * 2 - 1, role: 'user', content_text: `第${round}轮输入` }),
      createMessage({
        message_id: round * 2,
        role: 'assistant',
        content_text: `第${round}轮正文`,
        summary_content: `第${round}轮总结`,
      }),
    );
  }

  assert.deepEqual(
    collectStandalonePriorSummaryItems({ messages }).map(item => item.messageId),
    [2, 4, 6, 8, 10, 12],
  );

  // 推进水位线后，已归档的不再算作待归档
  assert.deepEqual(
    collectStandalonePriorSummaryItems({ messages, archivedUntilMessageId: 4 }).map(item => item.messageId),
    [6, 8, 10, 12],
  );

  // 缺小总结、或只有空白小总结的回合不算数
  const mixedSummaries: MessageRecord[] = [];
  for (let messageId = 1; messageId <= 12; messageId += 1) {
    const summary = messageId === 1 ? undefined : messageId === 2 ? '   ' : `第${messageId}条总结`;
    mixedSummaries.push(createMessage({ message_id: messageId, role: 'assistant', summary_content: summary }));
  }

  assert.deepEqual(
    collectStandalonePriorSummaryItems({ messages: mixedSummaries }).map(item => item.messageId),
    [3, 4],
  );
}

async function testArchiveStandaloneStageSummaryCompressesPendingSummaries(): Promise<void> {
  const seeded = await seedStandaloneArchiveScenario({
    playerName: '阶段归档角色',
    sendFullPreset: true,
  });
  const { messagesStore, settingsStore } = seeded;

  // 补到 10 轮：每轮 = 玩家输入 + AI 正文（AI 那侧带小总结）
  for (let round = 2; round <= 10; round += 1) {
    messagesStore.appendStandaloneMessage({
      role: 'user',
      raw_content: `第${round}轮输入`,
      content_text: `第${round}轮输入`,
      formatted: `第${round}轮输入`,
      action_options: [],
      stat_data_snapshot: seeded.statData,
    });
    messagesStore.appendStandaloneMessage({
      role: 'assistant',
      raw_content: `<contenttext>第${round}轮正文</contenttext>`,
      content_text: `第${round}轮正文`,
      formatted: `第${round}轮正文`,
      action_options: [],
      summary_content: `第${round}轮总结`,
      stat_data_snapshot: seeded.statData,
    });
  }
  await nextTick();

  // 默认阈值 100：只有 6 条待归档，不该提示
  const before = resolveStandaloneStageSummaryProgress();
  assert.equal(before.threshold, 100);
  assert.equal(before.pendingCount, 6);
  assert.equal(before.archivedCount, 0);
  assert.equal(before.isDue, false);

  // 阈值降到 5 就该提示了
  assert.equal(resolveStandaloneStageSummaryProgress(5).isDue, true);

  const originalFetch = globalThis.fetch;
  let capturedBody: { messages?: Array<{ role: string; content: string }> } = {};
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? '{}'));
    return createMockFetchResponse({
      jsonData: { choices: [{ message: { content: '  合并后的阶段总结  ' } }] },
    });
  }) as typeof fetch;

  try {
    const outcome = await archiveStandaloneStageSummary();

    assert.equal(outcome.archivedCount, 6);
    assert.equal(outcome.stageSummary, '合并后的阶段总结');
    assert.equal(outcome.archivedUntilMessageId, 11);

    // 确实把「旧阶段总结占位 + 这 6 条」一起送进了主 API
    const sentText = (capturedBody.messages ?? []).map(message => message.content).join('\n');
    assert.ok(sentText.includes('（无，这是第一次归档）'));
    assert.ok(sentText.includes('阶段归档角色的剧情总结'));
    assert.ok(sentText.includes('第6轮总结'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 归档后：水位线推进，待归档清零，已归档 6 条
  const after = resolveStandaloneStageSummaryProgress();
  assert.equal(after.pendingCount, 0);
  assert.equal(after.archivedCount, 6);
  assert.equal(after.archivedUntilMessageId, 11);
  assert.equal(after.stageSummary, '合并后的阶段总结');
  assert.equal(after.isDue, false);

  // 落进会话，刷新/读档都还在
  const session = loadStandaloneRuntimeSession();
  assert.equal(session?.stage_summary, '合并后的阶段总结');
  assert.equal(session?.stage_summary_archived_until_message_id, 11);

  const savedEntry = await saveStandaloneArchiveSnapshot();
  const payload = readStoredArchivePayload(savedEntry.id);
  assert.equal(payload.session.stage_summary, '合并后的阶段总结');
  assert.equal(payload.session.stage_summary_archived_until_message_id, 11);

  // 提示词换成「一段阶段总结」，不再逐条发旧小总结
  const latestUserMessage = [...messagesStore.messages].reverse().find(message => message.role === 'user');
  assert.ok(latestUserMessage);

  const combined = buildMainTurnPrompt(
    createStandaloneTurnInput({
      messages: messagesStore.messages,
      latestUserMessage,
      stageSummary: after.stageSummary,
      archivedUntilMessageId: after.archivedUntilMessageId,
    }),
  )
    .messages.map(message => message.content)
    .join('\n\n');

  assert.ok(combined.includes('[阶段总结]'));
  assert.ok(combined.includes('合并后的阶段总结'));
  assert.ok(!combined.includes('[前情提要]'));
  assert.ok(!combined.includes('阶段归档角色的剧情总结'));
  assert.ok(!combined.includes('第6轮总结'));

  // 再点一次：没有新内容，不该白花一次主 API 调用
  let secondFetchCallCount = 0;
  globalThis.fetch = (async () => {
    secondFetchCallCount += 1;
    return createMockFetchResponse({ jsonData: { choices: [{ message: { content: '不该被调用' } }] } });
  }) as typeof fetch;

  try {
    const secondOutcome = await archiveStandaloneStageSummary();
    assert.equal(secondOutcome.archivedCount, 0);
    assert.equal(secondFetchCallCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 阈值改成 200 也要能存下来
  settingsStore.stageSummaryThreshold = 200;
  assert.equal(resolveStandaloneStageSummaryProgress().threshold, 200);
}

function testAssistantApiDebugTracePreferredOverLegacyVariablePass(): void {
  const preferred = resolvePreferredVariableDebugPass({
    variable_update_pass: {
      api_label: 'openai_compatible:legacy-variable-pass',
      api_mode: 'openai_compatible',
      requested_at: '2026-04-12T16:00:00.000Z',
      transport_mode: 'non_streaming',
      request_messages: [{ role: 'user', content: '旧变量更新请求' }],
      request_body_text: '{"model":"legacy"}',
      raw_response_text: 'legacy response',
      extracted_text: '<UpdateVariable>[]</UpdateVariable>',
      error_message: null,
    },
    assistant_api_pass: {
      api_label: 'openai_compatible:assistant-api-pass',
      api_mode: 'openai_compatible',
      requested_at: '2026-04-12T16:01:00.000Z',
      transport_mode: 'streaming',
      request_messages: [{ role: 'user', content: '辅助 API 真实请求' }],
      request_body_text: '{"model":"assistant"}',
      raw_response_text: 'assistant response',
      extracted_text: '<UpdateVariable>[{"op":"replace","path":"/玩家/姓名","value":"辅助优先"}]</UpdateVariable>',
      error_message: null,
    },
  });

  assert.equal(preferred?.api_label, 'openai_compatible:assistant-api-pass');
  assert.equal(preferred?.request_messages[0]?.content, '辅助 API 真实请求');
}

function testRegisteredWorldbookRegistryIncludesAllCurrentEntries(): void {
  assert.equal(registeredWorldbookAssets.length, 11);
  assert.ok(registeredWorldbookAssets.some(asset => asset.name === '[WB]卡普阿的荣耀：血与沙'));
  assert.ok(registeredWorldbookAssets.some(asset => asset.name === '[WB]高考模拟器'));
  assert.ok(registeredWorldbookAssets.some(asset => asset.name === '[WB]火星采矿站人机共居'));
  assert.ok(registeredWorldbookAssets.some(asset => asset.name === '[WB]SongDynasty'));
  assert.ok(registeredWorldbookAssets.some(asset => asset.name === '[WB]明星志愿-未央市'));
  assert.match(registeredWorldbookContentByName['[WB]卡普阿的荣耀：血与沙'] ?? '', /卡普阿/);
  assert.match(registeredWorldbookContentByName['[WB]SongDynasty'] ?? '', /合道真气获取/);
  assert.match(registeredWorldbookContentByName['[WB]明星志愿-未央市'] ?? '', /未央市/);
  assert.equal(
    registeredWorldbookContentByName['[WB]激流·黄金时代:1980s'],
    registeredWorldbookContentByName['[WB]激流·黄金时代1980s'],
  );
}

function testPresetGroupHelpersSplitBuiltInAndWorkshopPresets(): void {
  const builtInPreset = {
    id: 'reform-era-1980s',
    name: '激流·黄金时代1980s',
    icon: '🌊',
    category: '测试',
    tags: [],
    description: '内置测试预设',
    config: {} as PresetConfig['config'],
  };
  const workshopPreset = {
    id: 'yiren-zhixia',
    name: '一人之下',
    icon: '🧪',
    category: '测试',
    tags: [],
    description: '创意工坊测试预设',
    config: {} as PresetConfig['config'],
  };
  const presets = [builtInPreset, workshopPreset];

  assert.equal(isWorkshopPreset(workshopPreset), true);
  assert.deepEqual(
    getBuiltInPresets(presets).map(preset => preset.id),
    ['reform-era-1980s'],
  );
  assert.deepEqual(
    presets.filter(preset => isWorkshopPreset(preset)).map(preset => preset.id),
    ['yiren-zhixia'],
  );
}

function testRegisteredWorldbookEntriesNormalizeToMainWorldbookLocalContent(): void {
  const entries = createRegisteredWorldbookLocalContentEntries([
    '[WB]卡普阿的荣耀：血与沙',
    '[WB]卡普阿的荣耀：血与沙',
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, '[WB]卡普阿的荣耀：血与沙');
  assert.equal(entries[0]?.kind, 'worldbook');
  assert.equal(entries[0]?.route, 'main');
  assert.equal(entries[0]?.enabled, true);
  assert.match(entries[0]?.content ?? '', /卡普阿/);
}

function testBuiltInPresetWorldbookAutoAttachUsesRegistry(): void {
  const presets = attachRegisteredWorldbooksToBuiltInPresets([
    {
      id: 'spartacus-ludus-capua',
      name: '卡普阿的荣耀：血与沙',
      icon: '🗡️',
      category: '测试',
      tags: [],
      description: '测试卡普阿世界书自动挂接',
      config: {} as PresetConfig['config'],
    },
    {
      id: 'gaokao-simulator',
      name: '百日誓师!高考!',
      icon: '📚',
      category: '测试',
      tags: [],
      description: '测试高考世界书自动挂接',
      config: {} as PresetConfig['config'],
      localContentEntries: [
        {
          name: '[WB]高考模拟器',
          content: registeredWorldbookContentByName['[WB]高考模拟器'],
          kind: 'worldbook',
          route: 'main',
          enabled: true,
        },
      ],
    },
    {
      id: 'unmatched-preset',
      name: '无匹配预设',
      icon: '🧪',
      category: '测试',
      tags: [],
      description: '不应自动得到任何世界书',
      config: {} as PresetConfig['config'],
    },
  ]);

  const capuaPreset = presets.find(preset => preset.id === 'spartacus-ludus-capua');
  const gaokaoPreset = presets.find(preset => preset.id === 'gaokao-simulator');
  const unmatchedPreset = presets.find(preset => preset.id === 'unmatched-preset');

  assert.ok(capuaPreset?.localContentEntries?.some(entry => entry.name === '[WB]卡普阿的荣耀：血与沙'));
  assert.equal(gaokaoPreset?.localContentEntries?.filter(entry => entry.name === '[WB]高考模拟器').length, 1);
  assert.equal(unmatchedPreset?.localContentEntries?.length ?? 0, 0);
}

function testPresetRehydrateUsesBuiltInIdMappingAndPreservesExistingEntries(): void {
  const editedContent = '这是用户本地修改过的高考世界书内容';
  const rehydratedPreset = rehydratePresetWithRegisteredWorldbooks({
    id: 'gaokao-simulator',
    name: '百日誓师!高考!',
    icon: '📚',
    category: '测试',
    tags: [],
    description: '验证内置 id 恢复路径。',
    config: {} as PresetConfig['config'],
    localContentEntries: [
      {
        name: '[WB]高考模拟器',
        content: editedContent,
        kind: 'worldbook',
        route: 'main',
        enabled: true,
      },
      {
        name: '已有补充说明',
        content: '保留原有本地条目',
        route: 'main',
        enabled: true,
      },
    ],
  });

  assert.equal(rehydratedPreset.localContentEntries?.filter(entry => entry.name === '[WB]高考模拟器').length, 1);
  assert.equal(
    rehydratedPreset.localContentEntries?.find(entry => entry.name === '[WB]高考模拟器')?.content,
    editedContent,
  );
  assert.equal(
    rehydratedPreset.localContentEntries?.find(entry => entry.name === '[WB]高考模拟器')?.registeredWorldbookName,
    '[WB]高考模拟器',
  );
  assert.ok(rehydratedPreset.localContentEntries?.some(entry => entry.name === '已有补充说明'));

  const missingWorldbookPreset = rehydratePresetWithRegisteredWorldbooks({
    id: 'gaokao-simulator',
    name: '百日誓师!高考!',
    icon: '📚',
    category: '测试',
    tags: [],
    description: '验证缺失时会补回内置世界书。',
    config: {} as PresetConfig['config'],
  });

  assert.ok(missingWorldbookPreset.localContentEntries?.some(entry => entry.name === '[WB]高考模拟器'));
}

function testPresetRehydrateSupportsExplicitRegisteredWorldbookMetadata(): void {
  const preset = rehydratePresetWithRegisteredWorldbooks({
    id: 'future-explicit-wb-preset',
    name: '未来预设',
    icon: '🧪',
    category: '测试',
    tags: [],
    description: '验证显式 metadata 恢复路径。',
    config: {} as PresetConfig['config'],
    registeredWorldbookNames: ['[WB]激流·黄金时代:1980s'],
  });

  assert.deepEqual(preset.registeredWorldbookNames, ['[WB]激流·黄金时代:1980s']);
  assert.equal(preset.localContentEntries?.length, 1);
  assert.equal(preset.localContentEntries?.[0]?.name, '[WB]激流·黄金时代1980s');
  assert.equal(preset.localContentEntries?.[0]?.content, registeredWorldbookContentByName['[WB]激流·黄金时代1980s']);
}

function testPresetRehydrateAppendsCanonicalRegisteredEntryWhenOnlySameNamedNonWorldbookExists(): void {
  const preset = rehydratePresetWithRegisteredWorldbooks({
    id: 'gaokao-simulator',
    name: '百日誓师!高考!',
    icon: '📚',
    category: '测试',
    tags: [],
    description: '验证同名非正式条目不会阻止补回正式 WB。',
    config: {} as PresetConfig['config'],
    localContentEntries: [
      {
        name: '[WB]高考模拟器',
        content: '只是一个同名说明，不是正式世界书。',
        kind: 'general',
        route: 'shared',
        enabled: true,
      },
    ],
  });

  assert.equal(preset.localContentEntries?.filter(entry => entry.name === '[WB]高考模拟器').length, 2);
  assert.ok(
    preset.localContentEntries?.some(
      entry =>
        entry.registeredWorldbookName === '[WB]高考模拟器' &&
        entry.content === registeredWorldbookContentByName['[WB]高考模拟器'],
    ),
  );
}

function testResolveMainPassWorldbookPromptFromTracePrefersActualSentSnapshot(): void {
  const prompt = resolveMainPassWorldbookPromptFromTrace({
    main_pass: {
      api_label: 'openai_compatible:test-main-pass',
      api_mode: 'openai_compatible',
      requested_at: '2026-04-15T00:00:00.000Z',
      transport_mode: 'non_streaming',
      request_messages: [
        { role: 'system', content: '系统协议消息' },
        { role: 'user', content: '[当前变量快照 stat_data]\n{"玩家":{"姓名":"测试玩家"}}' },
        {
          role: 'user',
          content: ['[本地内容:[WB]高考模拟器]', '[WB]高考模拟器', '这里是实际发送出去的世界书正文。'].join('\n'),
        },
        { role: 'assistant', content: '最近历史' },
        { role: 'user', content: '最新输入' },
      ],
      request_body_text: '{"model":"test-main-pass"}',
      raw_response_text: '{"choices":[{"message":{"content":"<contenttext>正文</contenttext>"}}]}',
      extracted_text: '<contenttext>正文</contenttext>',
      error_message: null,
    },
  });

  assert.match(prompt, /实际发送出去的世界书正文/);
  assert.match(prompt, /\[WB\]高考模拟器/);
}

async function testRendersLotteryRulesTemplate(): Promise<void> {
  const template = plotLotteryRulesTemplate;
  const result = renderStandaloneLocalContentTemplate({
    template,
    renderContext: createRenderContext(),
    sourceName: '[mvu_plot]抽奖规则.txt',
  });

  assert.equal(result.warning, null);
  assert.ok(result.content.includes('系统已强制生成如下1次抽奖结果'));
  assert.ok(result.content.includes('第1次：【传说】'));
  assert.ok(!result.content.includes('<%'));
}

async function testRendersVariableUpdateRulesTemplate(): Promise<void> {
  const template = variableUpdateRulesTemplate;
  const result = renderStandaloneLocalContentTemplate({
    template,
    renderContext: createRenderContext(),
    sourceName: '[mvu_update]变量更新规则.txt',
  });

  assert.equal(result.warning, null);
  assert.ok(result.content.includes('当前模式: 生存模式'));
  assert.ok(result.content.includes('人物档案.NPC_1.生存状态（老周，全部4项）'));
  assert.ok(!result.content.includes('<%_'));
  assert.ok(!result.content.includes('_%>'));
}

async function testFallsBackToRawTemplateOnRenderError(): Promise<void> {
  const template = '<% const broken = ; %>';
  const result = renderStandaloneLocalContentTemplate({
    template,
    renderContext: createRenderContext(),
    sourceName: 'broken-template.txt',
  });

  assert.equal(result.content, template);
  assert.ok(result.warning?.startsWith('模板渲染失败：'));
}

async function testResolvesPresetAwareLocalContentEntries(): Promise<void> {
  const preset: PresetConfig = {
    id: 'preset-test',
    name: '测试预设',
    icon: '🧪',
    category: '测试分类',
    tags: ['测试'],
    description: '用于测试本地内容合并。',
    config: {} as PresetConfig['config'],
    localContentEntries: [
      {
        name: '预设附加规则',
        content: '来自预设的附加内容',
        route: 'main',
        enabled: true,
      },
    ],
  };

  const entries = resolveStandaloneLocalContentEntries({
    preset,
    enabledMap: {
      'main-api-prompt': false,
    },
  });

  const builtinEntry = entries.find(entry => entry.id === 'main-api-prompt');
  const presetEntry = entries.find(entry => entry.title === '预设附加规则');

  assert.ok(builtinEntry);
  assert.equal(builtinEntry.enabled, true);
  assert.equal(builtinEntry.sourceName, '[mvu_plot]不更新变量.md');
  assert.ok(presetEntry);
  assert.equal(presetEntry.sourceKind, 'preset');
  assert.equal(presetEntry.enabled, true);
  assert.equal(presetEntry.route, 'main');
  assert.equal(presetEntry.kind, 'general');
}

async function testOpeningPresetLocalContentDoesNotMasqueradeAsTavernPresetFlow(): Promise<void> {
  const preset: PresetConfig = {
    id: 'preset-action-options-test',
    name: '测试开局模板',
    icon: '📘',
    category: '测试分类',
    tags: ['测试'],
    description: '验证开局模板附带内容不会被误当成酒馆预设来源。',
    config: {} as PresetConfig['config'],
    localContentEntries: [
      {
        name: '行动选项规则',
        content: '这是一段来自开局模板的附带内容。',
        route: 'main',
        enabled: true,
      },
    ],
  };

  const entries = resolveStandaloneLocalContentEntries({
    preset,
    enabledMap: {},
  });

  const presetEntry = entries.find(entry => entry.title === '行动选项规则');

  assert.ok(presetEntry);
  assert.equal(presetEntry.sourceKind, 'preset');
  assert.equal(presetEntry.sourceName, '测试开局模板 / 行动选项规则');
  assert.equal(presetEntry.kind, 'general');
}

async function testInfersFormalKindsForLegacyAndExplicitLocalContentEntries(): Promise<void> {
  assert.equal(inferStandaloneLocalContentKind({ name: '[WB]高考模拟器' }), 'worldbook');
  assert.equal(inferStandaloneLocalContentKind({ name: '[mvu_plot]抽奖规则' }), 'plot_rule');
  assert.equal(
    inferStandaloneLocalContentKind({
      name: '变量补充检查',
      route: 'variable_update',
    }),
    'variable_update_rule',
  );
  assert.equal(inferStandaloneLocalContentKind({ name: '普通补充说明', route: 'main' }), 'general');

  const preset: PresetConfig = {
    id: 'preset-kind-test',
    name: '正式分类测试',
    icon: '🧪',
    category: '测试分类',
    tags: ['测试'],
    description: '验证本地内容正式分类字段。',
    config: {} as PresetConfig['config'],
    localContentEntries: [
      {
        name: '[WB]开局背景',
        content: '世界书正文',
        route: 'main',
        enabled: true,
      },
      {
        name: '变量补充检查',
        content: '变量更新时使用',
        route: 'variable_update',
        enabled: true,
      },
    ],
  };

  const entries = resolveStandaloneLocalContentEntries({
    preset,
    enabledMap: {},
  });

  assert.equal(entries.find(entry => entry.title === '[WB]开局背景')?.kind, 'worldbook');
  assert.equal(entries.find(entry => entry.title === '变量补充检查')?.kind, 'variable_update_rule');
}

async function testAppliesVariableUpdateModeToStandaloneLocalContent(): Promise<void> {
  const baseEnabledMap = {
    'variable-update-format': false,
    'variable-update-rules': false,
    'variable-update-thought-template': true,
    'main-api-prompt': true,
  };

  const fixedEnabledMap = applyFixedVariableUpdateStandaloneLocalContent(baseEnabledMap);
  assert.equal(fixedEnabledMap['variable-update-format'], true);
  assert.equal(fixedEnabledMap['variable-update-rules'], true);
  assert.equal('variable-update-thought-template' in fixedEnabledMap, false);
  assert.equal(fixedEnabledMap['main-api-prompt'], true);
}

async function testNormalizesStoredStandaloneLocalContentSettingsFromMode(): Promise<void> {
  const settings = resolveStoredStandaloneLocalContentSettings({
    storedSettings: {
      enabledAssets: {
        'variable-update-format': true,
        'variable-update-rules': true,
        'variable-update-thought-template': true,
        'plot-text-to-image': false,
        'plot-online-mode': false,
        'main-api-prompt': true,
      },
    },
    imagePromptEnabled: true,
    onlineModeEnabled: true,
  });

  assert.equal(settings.enabledAssets['variable-update-format'], true);
  assert.equal(settings.enabledAssets['variable-update-rules'], true);
  assert.equal('variable-update-thought-template' in settings.enabledAssets, false);
  assert.equal(settings.enabledAssets['plot-text-to-image'], true);
  assert.equal(settings.enabledAssets['plot-online-mode'], true);
  assert.equal(settings.enabledAssets['main-api-prompt'], true);
}

async function testMigratesKnownLegacyWorldbookEntriesFromCompatAssets(): Promise<void> {
  const migrationResult = migrateLegacyPresetLocalContent({
    localContentEntries: normalizeLocalContentEntriesInput([
      {
        name: '已有附加条目',
        content: '保留已有内容',
        route: 'main',
        enabled: true,
      },
    ]),
    worldbookEntries: ['[mvu_plot] [WB]高考模拟器', '[WB]1990·温馨小屋'],
  });

  assert.equal(migrationResult.warnings.length, 0);
  assert.equal(migrationResult.localContentEntries.length, 3);

  const gaokaoEntry = migrationResult.localContentEntries.find(entry => entry.name === '[WB]高考模拟器');
  const familyEntry = migrationResult.localContentEntries.find(entry => entry.name === '[WB]1990·温馨小屋');

  assert.ok(gaokaoEntry);
  assert.equal(gaokaoEntry?.kind, 'worldbook');
  assert.equal(gaokaoEntry?.route, 'main');
  assert.equal(gaokaoEntry?.enabled, true);
  assert.equal(gaokaoEntry?.content.trim(), legacyWorldbookContentByName['[WB]高考模拟器'].trim());
  assert.ok(gaokaoEntry?.content.includes('高考模拟器'));

  assert.ok(familyEntry);
  assert.equal(familyEntry?.content.trim(), legacyWorldbookContentByName['[WB]1990·温馨小屋'].trim());
  assert.ok(familyEntry?.content.includes('1990·温馨小屋'));
}

async function testWarnsOnUnknownLegacyWorldbookEntriesWithoutDroppingExistingContent(): Promise<void> {
  const migrationResult = migrateLegacyPresetLocalContent({
    localContentEntries: [
      {
        name: '已有条目',
        content: '已有正文',
        route: 'main',
        enabled: true,
      },
    ],
    worldbookEntries: ['[WB]不存在的老世界书'],
  });

  assert.equal(migrationResult.localContentEntries.length, 1);
  assert.equal(migrationResult.localContentEntries[0]?.name, '已有条目');
  assert.deepEqual(migrationResult.warnings, [
    {
      code: 'legacy_worldbook_entries_unresolved',
      entryNames: ['[WB]不存在的老世界书'],
    },
  ]);
}

function createStandaloneTurnInput(overrides: Partial<StandaloneLocalTurnInput> = {}): StandaloneLocalTurnInput {
  return {
    mainApis: [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://example.com/v1',
        key: 'test-key',
        model: 'test-model',
        source: 'openai_compatible',
      },
    ],
    assistantApis: [],
    statData: createRenderContext().statData as StandaloneLocalTurnInput['statData'],
    messages: [createMessage()],
    latestUserMessage: createMessage(),
    worldDifficulty: '最简单',
    localContentEnabledMap: {
      'main-api-prompt': true,
      'current-stat-snapshot': true,
      'plot-lottery-rules': true,
      'plot-world-difficulty': true,
      'variable-update-format': true,
      'variable-update-rules': true,
    },
    localContentBuiltinRouteOverrides: getStandaloneLocalContentBuiltinRouteOverrides(),
    selectedPreset: null,
    ...overrides,
  };
}

function collectPromptMessagesByRole(
  prompt: { messages: Array<{ role: string; content: string }> },
  role: string,
): string[] {
  return prompt.messages.filter(message => message.role === role).map(message => message.content);
}

async function testRemovedVariableUpdateThoughtTemplateStaysOutOfManifestAndPrompts(): Promise<void> {
  const manifest = getStandaloneLocalContentManifest();
  assert.equal(
    manifest.some(entry => entry.id === 'variable-update-thought-template'),
    false,
  );
  assert.equal(
    manifest.some(entry => entry.title === '变量更新思路参考'),
    false,
  );

  const input = createStandaloneTurnInput({
    localContentEnabledMap: {
      ...createStandaloneTurnInput().localContentEnabledMap,
      'variable-update-thought-template': true,
    },
  });

  const mainPrompt = buildMainTurnPrompt(input);
  const secondPassPrompt = buildVariableUpdateSecondPassPrompt({
    statData: input.statData,
    latestUserMessage: input.latestUserMessage,
    assistantContentText: '测试正文',
    messages: input.messages,
    worldDifficulty: input.worldDifficulty,
    localContentEnabledMap: input.localContentEnabledMap,
    selectedPreset: input.selectedPreset,
  });
  const secondPassCombined = secondPassPrompt.messages.map(message => message.content).join('\n\n');

  const mainPromptCombined = mainPrompt.messages.map(message => message.content).join('\n\n');

  assert.ok(!mainPromptCombined.includes('变量更新思路参考'));
  assert.ok(!mainPromptCombined.includes('[本地内容:变量更新思路参考]'));
  assert.ok(!secondPassCombined.includes('变量更新思路参考'));
  assert.ok(!secondPassCombined.includes('[本地内容:变量更新思路参考]'));
}

function createArchivePreset(overrides: Partial<PresetConfig> = {}): PresetConfig {
  return {
    id: 'archive-preset',
    name: '本地存档测试预设',
    icon: '💾',
    category: '测试分类',
    tags: ['archive'],
    description: '验证 standalone 存档保存与恢复。',
    config: getStandaloneTestSchema().parse({}) as PresetConfig['config'],
    localContentEntries: [
      {
        name: '[WB]存档测试条目',
        content: '来自存档预设的本地条目',
        kind: 'worldbook',
        route: 'main',
        enabled: true,
      },
    ],
    ...overrides,
  };
}

function createArchiveStatData(playerName: string) {
  const statData = getStandaloneTestSchema().parse({}) as StandaloneLocalTurnInput['statData'];
  statData.玩家.姓名 = playerName;
  statData.世界.空间定位.当前位置 = `${playerName}的基地`;
  statData.世界.时间系统.当前时间 = `${playerName}时间`;
  return statData;
}

function createAssistantReply(contentText: string, playerName: string): string {
  return [
    `<contenttext>${contentText}</contenttext>`,
    '<summary>阶段总结</summary>',
    '<UpdateVariable><Analysis>test-analysis</Analysis><JSONPatch>[]</JSONPatch></UpdateVariable>',
    `<StatusBlock>{"玩家":{"姓名":"${playerName}"}}</StatusBlock>`,
    '<action_options>1. 测试动作</action_options>',
  ].join('');
}

function readStoredArchivePayload(archiveId: string): StandaloneArchiveFile {
  const stored = localStorage.getItem(`${STANDALONE_ARCHIVE_STORAGE_KEY_PREFIX}${archiveId}`);
  assert.ok(stored, `expected standalone archive payload for ${archiveId}`);
  return JSON.parse(stored) as StandaloneArchiveFile;
}

async function seedStandaloneArchiveScenario(input: {
  playerName: string;
  sendFullPreset: boolean;
  presetName?: string;
}) {
  resetStandaloneTestEnvironment();

  const statData = createArchiveStatData(input.playerName);
  const selectedPreset = createArchivePreset({
    id: `${input.playerName}-preset`,
    name: input.presetName ?? `${input.playerName}预设`,
    config: statData as PresetConfig['config'],
  });
  const standaloneLocalContent = resolveStoredStandaloneLocalContentSettings({
    storedSettings: {
      enabledAssets: {
        'main-api-prompt': true,
        'plot-online-mode': true,
      },
    },
    imagePromptEnabled: true,
    onlineModeEnabled: true,
  });

  const settingsStore = useSettingsStore();
  const setupStore = useSetupStore();
  const messagesStore = useMessagesStore();

  setupStore.selectedPreset = selectedPreset;
  Object.assign(setupStore.config, statData);
  settingsStore.standaloneLocalContent = standaloneLocalContent;
  settingsStore.mainApi = {
    ...settingsStore.mainApi,
    ...createDefaultApiConfig(),
    apiurl: 'https://main-archive.example.com/v1/chat/completions',
    key: 'main-archive-key',
    model: 'main-archive-model',
    source: 'openai_compatible',
  };
  settingsStore.assistantApis = [
    {
      ...createDefaultApiConfig(),
      apiurl: 'https://assistant-archive.example.com/v1/chat/completions',
      key: 'assistant-archive-key',
      model: 'assistant-archive-model',
      source: 'openai_compatible',
    },
  ];

  ensureStandaloneRuntimeBootstrap(statData, {
    preset: selectedPreset,
    standaloneLocalContent,
    sendFullPreset: true,
  });
  syncStandaloneRuntimeSessionStatData(statData, {
    preset: selectedPreset,
    standaloneLocalContent,
    sendFullPreset: true,
  });

  messagesStore.appendStandaloneMessage({
    role: 'user',
    raw_content: `${input.playerName}的开局输入`,
    content_text: `${input.playerName}的开局输入`,
    formatted: `${input.playerName}的开局输入`,
    action_options: [],
    stat_data_snapshot: statData,
  });
  messagesStore.appendStandaloneMessage({
    role: 'assistant',
    raw_content: `<contenttext>${input.playerName}的第一段剧情</contenttext>`,
    content_text: `${input.playerName}的第一段剧情`,
    formatted: `${input.playerName}的第一段剧情`,
    action_options: ['继续调查', '立刻休息'],
    summary_content: `${input.playerName}的剧情总结`,
    stat_data_snapshot: statData,
  });

  await nextTick();

  return {
    statData,
    selectedPreset,
    standaloneLocalContent,
    settingsStore,
    setupStore,
    messagesStore,
  };
}

async function testSaveStandaloneArchiveSnapshotPersistsIndexAndPayload(): Promise<void> {
  const { setupStore } = await seedStandaloneArchiveScenario({
    playerName: '存档保存测试',
    sendFullPreset: true,
  });

  const entry = await saveStandaloneArchiveSnapshot();
  const archives = listStandaloneArchives();
  const payload = readStoredArchivePayload(entry.id);

  assert.equal(archives.length, 1);
  assert.equal(archives[0]?.id, entry.id);
  assert.equal(entry.presetName, setupStore.selectedPreset?.name ?? '');
  assert.equal(entry.messageCount, 2);
  assert.equal(payload.archiveId, entry.id);
  assert.equal(payload.version, '3.0.0');
  assert.equal(payload.currentChatId, payload.session.id);
  assert.deepEqual(payload.currentMessageIds, [0, 1]);
  assert.equal(payload.floorSnapshots.length, 2);
  assert.deepEqual(
    payload.floorSnapshots.map(snapshot => snapshot.message_id),
    payload.currentMessageIds,
  );
  assert.equal(payload.floorSnapshots[1]?.content_text, '存档保存测试的第一段剧情');
  assert.equal(payload.floorSnapshots[1]?.stat_data_snapshot?.玩家?.姓名, '存档保存测试');
  assert.equal(payload.currentVariableSnapshot.玩家.姓名, '存档保存测试');
  assert.equal(payload.selectedPreset?.id, setupStore.selectedPreset?.id ?? '');
  assert.equal(payload.sendFullPreset, true);
  assert.equal(payload.standaloneLocalContent?.enabledAssets['plot-online-mode'], true);
  assert.equal(payload.session.stat_data.玩家.姓名, '存档保存测试');
  assert.match(entry.summary, /存档保存测试/);
}

async function testRestoreStandaloneArchiveRestoresRuntimeAndStores(): Promise<void> {
  const seeded = await seedStandaloneArchiveScenario({
    playerName: '恢复前角色',
    sendFullPreset: true,
    presetName: '恢复前预设',
  });
  const savedEntry = await saveStandaloneArchiveSnapshot();

  seeded.setupStore.selectedPreset = createArchivePreset({
    id: 'mutated-preset',
    name: '被覆盖的预设',
    config: createArchiveStatData('被覆盖角色') as PresetConfig['config'],
  });
  seeded.settingsStore.standaloneLocalContent = {
    enabledAssets: {
      'main-api-prompt': false,
      'plot-online-mode': false,
    },
  };
  seeded.settingsStore.mainApi = {
    ...seeded.settingsStore.mainApi,
  };
  seeded.messagesStore.clearMessages();

  const mutatedStatData = createArchiveStatData('被覆盖角色');
  ensureStandaloneRuntimeBootstrap(mutatedStatData, {
    preset: seeded.setupStore.selectedPreset,
    standaloneLocalContent: seeded.settingsStore.standaloneLocalContent,
    sendFullPreset: true,
  });
  syncStandaloneRuntimeSessionStatData(mutatedStatData, {
    preset: seeded.setupStore.selectedPreset,
    standaloneLocalContent: seeded.settingsStore.standaloneLocalContent,
    sendFullPreset: true,
  });

  const restoreOutcome = await restoreStandaloneArchiveById(savedEntry.id);
  await flushScheduledUiEffects();

  const restoredSession = loadStandaloneRuntimeSession();
  const restoredMessages = loadStandaloneRuntimeMessages();

  assert.ok(restoredSession);
  assert.ok(restoredMessages);
  assert.deepEqual(restoreOutcome, {
    archiveId: savedEntry.id,
    resumedImmediately: true,
    requiresSettingsResume: false,
  });
  assert.equal(reloadCallCount, 0);
  assert.equal(seeded.setupStore.selectedPreset?.name, '恢复前预设');
  assert.equal(seeded.settingsStore.standaloneLocalContent.enabledAssets['plot-online-mode'], false);
  assert.equal('variable-update-thought-template' in seeded.settingsStore.standaloneLocalContent.enabledAssets, false);
  assert.equal(restoredSession.stat_data.玩家.姓名, '恢复前角色');
  assert.equal(loadStandaloneStatData().玩家.姓名, '恢复前角色');
  assert.equal(seeded.setupStore.config.玩家.姓名, '恢复前角色');
  assert.equal(restoredMessages.records.length, 2);
  assert.equal(restoredMessages.records[1]?.content_text, '恢复前角色的第一段剧情');
  assert.equal(seeded.messagesStore.messages.length, 2);
  assert.equal(seeded.messagesStore.messages[1]?.content_text, '恢复前角色的第一段剧情');
}

async function testImportStandaloneArchiveFileWritesListAndRestoresState(): Promise<void> {
  await seedStandaloneArchiveScenario({
    playerName: '导入来源角色',
    sendFullPreset: true,
    presetName: '导入来源预设',
  });
  const savedEntry = await saveStandaloneArchiveSnapshot();
  const exportedPayload = readStoredArchivePayload(savedEntry.id);

  resetStandaloneTestEnvironment();
  const settingsStore = useSettingsStore();
  const setupStore = useSetupStore();
  const messagesStore = useMessagesStore();

  settingsStore.mainApi = {
    ...createDefaultApiConfig(),
    apiurl: 'https://main-import.example.com/v1/chat/completions',
    key: 'main-import-key',
    model: 'main-import-model',
    source: 'openai_compatible',
  };
  settingsStore.assistantApis = [
    {
      ...createDefaultApiConfig(),
      apiurl: 'https://assistant-import.example.com/v1/chat/completions',
      key: 'assistant-import-key',
      model: 'assistant-import-model',
      source: 'openai_compatible',
    },
  ];

  const importFile = new File([JSON.stringify(exportedPayload)], 'standalone-archive.json', {
    type: 'application/json',
  });
  const restoreOutcome = await importArchiveFile(importFile);
  await flushScheduledUiEffects();

  const archives = listStandaloneArchives();
  const restoredSession = loadStandaloneRuntimeSession();

  assert.equal(archives.length, 1);
  assert.equal(archives[0]?.id, exportedPayload.archiveId);
  assert.equal(exportedPayload.currentChatId, exportedPayload.session.id);
  assert.deepEqual(exportedPayload.currentMessageIds, [0, 1]);
  assert.deepEqual(restoreOutcome, {
    archiveId: exportedPayload.archiveId,
    resumedImmediately: true,
    requiresSettingsResume: false,
  });
  assert.equal(reloadCallCount, 0);
  assert.ok(restoredSession);
  assert.equal(restoredSession.stat_data.玩家.姓名, '导入来源角色');
  assert.equal(setupStore.selectedPreset?.name, '导入来源预设');
  assert.equal(setupStore.config.玩家.姓名, '导入来源角色');
  assert.equal('variable-update-thought-template' in settingsStore.standaloneLocalContent.enabledAssets, false);
  assert.equal(messagesStore.messages.length, 2);
  assert.equal(messagesStore.messages[1]?.content_text, '导入来源角色的第一段剧情');
}

async function testSetupStoreRestoreRehydratesStoredBuiltInPreset(): Promise<void> {
  resetStandaloneTestEnvironment();

  // 先把会话造出来并落盘，再往「这个会话作用域」下写预设记忆。
  // 少了会话这一步，读取路径拿不到键、直接返回 null（产品是有意这么设计的：
  // 选预设发生在点「开始游戏」之前，那时还没会话，写了也会落到兜底作用域）。
  const session = createSeededStandaloneRuntimeSession({});
  persistStandaloneRuntimeSession(session);

  localStorage.setItem(
    `${STANDALONE_SELECTED_PRESET_STORAGE_KEY_PREFIX}:${session.id}`,
    JSON.stringify({
      id: 'china-1990s-family',
      name: '温馨小屋',
      icon: '🏠',
      category: '测试',
      tags: ['内置'],
      description: '验证本地记忆恢复时补回 WB。',
      config: getStandaloneTestSchema().parse({}),
    } satisfies PresetConfig),
  );

  const setupStore = useSetupStore();

  assert.equal(setupStore.selectedPreset?.id, 'china-1990s-family');
  assert.ok(setupStore.selectedPreset?.localContentEntries?.some(entry => entry.name === '[WB]1990·温馨小屋'));
}

async function testSetupStoreImportPresetRehydratesRegisteredWorldbooks(): Promise<void> {
  resetStandaloneTestEnvironment();
  const setupStore = useSetupStore();
  const importedPresetFile = new File(
    [
      JSON.stringify({
        id: 'future-imported-preset',
        name: '导入未来预设',
        icon: '📥',
        category: '测试',
        tags: ['导入'],
        description: '验证导入预设时补回 metadata 世界书。',
        config: getStandaloneTestSchema().parse({}),
        registeredWorldbookNames: ['[WB]乐吧欢乐公寓'],
      }),
    ],
    'imported-preset.json',
    { type: 'application/json' },
  );

  const imported = await setupStore.importPreset(importedPresetFile);

  assert.equal(imported, true);
  assert.equal(setupStore.selectedPreset?.id, 'future-imported-preset');
  assert.deepEqual(setupStore.selectedPreset?.registeredWorldbookNames, ['[WB]乐吧欢乐公寓']);
  assert.ok(setupStore.selectedPreset?.localContentEntries?.some(entry => entry.name === '[WB]乐吧欢乐公寓'));
}

async function testSetupStoreAiGeneratedPresetRehydratesRegisteredWorldbooks(): Promise<void> {
  resetStandaloneTestEnvironment();
  const setupStore = useSetupStore();
  const applied = await setupStore.applyAiGeneratedConfig(
    JSON.stringify({
      id: 'ai-generated-future-preset',
      name: 'AI 生成未来预设',
      icon: '🤖',
      category: '测试',
      tags: ['AI'],
      description: '验证 AI 生成预设时补回 metadata 世界书。',
      config: getStandaloneTestSchema().parse({}),
      registeredWorldbookNames: ['[WB]火星采矿站人机共居'],
    }),
  );

  assert.equal(applied, true);
  assert.equal(setupStore.selectedPreset?.id, 'ai-generated-future-preset');
  assert.deepEqual(setupStore.selectedPreset?.registeredWorldbookNames, ['[WB]火星采矿站人机共居']);
  assert.ok(setupStore.selectedPreset?.localContentEntries?.some(entry => entry.name === '[WB]火星采矿站人机共居'));
}

async function testArchiveRestoreRehydratesRegisteredWorldbooksForStoredPreset(): Promise<void> {
  resetStandaloneTestEnvironment();
  const settingsStore = useSettingsStore();
  const setupStore = useSetupStore();
  const messagesStore = useMessagesStore();
  const statData = createArchiveStatData('归档恢复角色');

  settingsStore.mainApi = {
    ...settingsStore.mainApi,
    ...createDefaultApiConfig(),
    apiurl: 'https://archive-restore.example.com/v1/chat/completions',
    key: 'archive-restore-key',
    model: 'archive-restore-model',
    source: 'openai_compatible',
  };
  settingsStore.assistantApis = [
    {
      ...createDefaultApiConfig(),
      apiurl: 'https://archive-restore-assistant.example.com/v1/chat/completions',
      key: 'archive-restore-assistant-key',
      model: 'archive-restore-assistant-model',
      source: 'openai_compatible',
    },
  ];

  setupStore.selectedPreset = {
    id: 'gaokao-simulator',
    name: '百日誓师!高考!',
    icon: '📚',
    category: '测试',
    tags: ['归档'],
    description: '验证归档恢复时补回内置 WB。',
    config: statData as PresetConfig['config'],
  };
  Object.assign(setupStore.config, statData);

  ensureStandaloneRuntimeBootstrap(statData, {
    preset: setupStore.selectedPreset,
    standaloneLocalContent: settingsStore.standaloneLocalContent,
    sendFullPreset: true,
  });
  syncStandaloneRuntimeSessionStatData(statData, {
    preset: setupStore.selectedPreset,
    standaloneLocalContent: settingsStore.standaloneLocalContent,
    sendFullPreset: true,
  });

  messagesStore.appendStandaloneMessage({
    role: 'user',
    raw_content: '归档恢复输入',
    content_text: '归档恢复输入',
    formatted: '归档恢复输入',
    action_options: [],
    stat_data_snapshot: statData,
  });
  messagesStore.appendStandaloneMessage({
    role: 'assistant',
    raw_content: '<contenttext>归档恢复正文</contenttext>',
    content_text: '归档恢复正文',
    formatted: '归档恢复正文',
    action_options: [],
    stat_data_snapshot: statData,
  });
  await nextTick();

  const savedEntry = await saveStandaloneArchiveSnapshot();

  setupStore.selectedPreset = null;
  messagesStore.clearMessages();

  await restoreStandaloneArchiveById(savedEntry.id);
  await flushScheduledUiEffects();

  assert.equal(setupStore.selectedPreset?.id, 'gaokao-simulator');
  assert.ok(setupStore.selectedPreset?.localContentEntries?.some(entry => entry.name === '[WB]高考模拟器'));
}

async function testRestoreStandaloneArchiveRequiresApiSetupBeforeResumingOnCleanBrowser(): Promise<void> {
  const seeded = await seedStandaloneArchiveScenario({
    playerName: '待补接口角色',
    sendFullPreset: true,
    presetName: '待补接口预设',
  });
  const savedEntry = await saveStandaloneArchiveSnapshot();
  const payload = readStoredArchivePayload(savedEntry.id);

  resetStandaloneTestEnvironment();
  localStorage.setItem(`th1980s:standalone-archive:${savedEntry.id}`, JSON.stringify(payload));

  const setupStore = useSetupStore();
  const messagesStore = useMessagesStore();

  const restoreOutcome = await restoreStandaloneArchiveById(savedEntry.id);
  await flushScheduledUiEffects();

  const pendingResume = loadPendingStandaloneArchiveResume();
  const restoredSession = loadStandaloneRuntimeSession();

  assert.ok(pendingResume);
  assert.equal(pendingResume?.archiveId, savedEntry.id);
  assert.equal(setupStore.currentPage, 'settings');
  assert.ok(restoredSession);
  assert.equal(restoredSession?.stat_data.玩家.姓名, '待补接口角色');
  assert.equal(messagesStore.messages.length, 2);
  assert.equal(messagesStore.messages[1]?.content_text, '待补接口角色的第一段剧情');
  assert.deepEqual(restoreOutcome, {
    archiveId: savedEntry.id,
    resumedImmediately: false,
    requiresSettingsResume: true,
  });
  assert.equal(reloadCallCount, 0);

  void seeded;
}

async function testImportStandaloneArchiveRequiresApiSetupBeforeResumingOnCleanBrowser(): Promise<void> {
  await seedStandaloneArchiveScenario({
    playerName: '导入待补接口角色',
    sendFullPreset: true,
    presetName: '导入待补接口预设',
  });
  const savedEntry = await saveStandaloneArchiveSnapshot();
  const exportedPayload = readStoredArchivePayload(savedEntry.id);

  resetStandaloneTestEnvironment();
  const setupStore = useSetupStore();
  const messagesStore = useMessagesStore();

  const importFile = new File([JSON.stringify(exportedPayload)], 'standalone-archive-clean-browser.json', {
    type: 'application/json',
  });
  const restoreOutcome = await importArchiveFile(importFile);
  await flushScheduledUiEffects();

  const pendingResume = loadPendingStandaloneArchiveResume();
  const restoredSession = loadStandaloneRuntimeSession();

  assert.ok(pendingResume);
  assert.equal(pendingResume?.archiveId, exportedPayload.archiveId);
  assert.equal(exportedPayload.currentChatId, exportedPayload.session.id);
  assert.deepEqual(exportedPayload.currentMessageIds, [0, 1]);
  assert.equal(setupStore.currentPage, 'settings');
  assert.ok(restoredSession);
  assert.equal(restoredSession?.stat_data.玩家.姓名, '导入待补接口角色');
  assert.equal(messagesStore.messages.length, 2);
  assert.equal(messagesStore.messages[1]?.content_text, '导入待补接口角色的第一段剧情');
  assert.deepEqual(restoreOutcome, {
    archiveId: exportedPayload.archiveId,
    resumedImmediately: false,
    requiresSettingsResume: true,
  });
  assert.equal(reloadCallCount, 0);
}

function testPendingArchiveResumeStateRoundTrip(): void {
  resetStandaloneTestEnvironment();

  localStorage.setItem(
    'th1980s:standalone-archive-pending-resume',
    JSON.stringify({ archiveId: 'pending-archive-id', restoredAt: '2026-04-07T00:00:00.000Z' }),
  );

  const pendingResume = loadPendingStandaloneArchiveResume();
  assert.ok(pendingResume);
  assert.equal(pendingResume?.archiveId, 'pending-archive-id');

  clearPendingStandaloneArchiveResume();
  assert.equal(loadPendingStandaloneArchiveResume(), null);
}

async function testImportStandaloneArchiveRejectsOldArchiveVersion(): Promise<void> {
  resetStandaloneTestEnvironment();

  const legacyArchivePayload = {
    version: '2.1.0',
    mode: 'standalone-runtime',
    archiveId: 'legacy-archive-id',
    createdAt: '2026-04-08T00:00:00.000Z',
    summary: '旧版存档',
    sourceChatId: 'legacy-chat-id',
    sourceMessageId: 1,
    session: createSeededStandaloneRuntimeSession(createArchiveStatData('旧版角色')),
    messages: {
      session_id: 'legacy-chat-id',
      next_message_id: 2,
      records: [],
    },
    selectedPreset: null,
    standaloneLocalContent: {
      enabledAssets: {},
    },
    sendFullPreset: true,
  } satisfies Record<string, unknown>;

  const importFile = new File([JSON.stringify(legacyArchivePayload)], 'legacy-standalone-archive.json', {
    type: 'application/json',
  });

  await assert.rejects(importArchiveFile(importFile), /当前仅支持导入这套完整快照归档文件，不支持旧版存档文件/);
  assert.equal(listStandaloneArchives().length, 0);
}

async function testVariableUpdateFormatPromptBlockAlwaysPresentInFixedMode(): Promise<void> {
  const enabledInput = createStandaloneTurnInput();
  const enabledMainPrompt = buildMainTurnPrompt(enabledInput);
  const enabledSecondPassPrompt = buildVariableUpdateSecondPassPrompt({
    statData: enabledInput.statData,
    latestUserMessage: enabledInput.latestUserMessage,
    assistantContentText: '测试正文',
    messages: enabledInput.messages,
    worldDifficulty: enabledInput.worldDifficulty,
    localContentEnabledMap: enabledInput.localContentEnabledMap,
    localContentBuiltinRouteOverrides: enabledInput.localContentBuiltinRouteOverrides,
    selectedPreset: enabledInput.selectedPreset,
  });

  const enabledMainPromptCombined = enabledMainPrompt.messages.map(message => message.content).join('\n\n');

  assert.equal((enabledMainPromptCombined.match(/\[本地内容:变量输出格式\]/g) ?? []).length, 0);
  assert.equal(enabledSecondPassPrompt.messages[0]?.role, 'user');
  assert.ok(enabledSecondPassPrompt.messages[0]?.content.includes('[当前变量快照 stat_data]'));
  assert.equal(enabledSecondPassPrompt.messages[1]?.role, 'assistant');
  assert.equal(enabledSecondPassPrompt.messages[1]?.content, '测试正文');
  assert.equal(enabledSecondPassPrompt.messages[2]?.role, 'user');
  assert.equal(enabledSecondPassPrompt.messages[2]?.content, enabledInput.latestUserMessage.content_text);
  assert.equal(enabledSecondPassPrompt.messages[3]?.role, 'system');
  assert.ok(enabledSecondPassPrompt.messages[3]?.content.includes('[Meta.System]'));
  assert.equal(enabledSecondPassPrompt.messages[4]?.role, 'user');
  assert.ok(enabledSecondPassPrompt.messages[4]?.content.includes('[本地内容:变量输出格式]'));
  assert.ok(enabledSecondPassPrompt.messages[4]?.content.includes('[本地内容:变量更新规则]'));
}

async function testLotteryRulePromptBlockOnlyAppearsForScriptedLotteryTurn(): Promise<void> {
  const normalPrompt = buildMainTurnPrompt(createStandaloneTurnInput());
  const lotteryPrompt = buildMainTurnPrompt(
    createStandaloneTurnInput({
      statData: createRenderContext({
        statData: {
          ...createRenderContext().statData,
          设置: {
            ...createRenderContext().statData.设置,
            积分系统: {
              ...createRenderContext().statData.设置.积分系统,
              抽奖次数: 11,
              保底触发: true,
            },
          },
        },
      }).statData as StandaloneLocalTurnInput['statData'],
      scriptedTurn: {
        kind: 'lottery',
        promptText: '## 🎰 开始抽奖!测试玩家发起了11次抽奖，请生成抽奖结果。',
      },
    }),
  );

  const normalPromptCombined = normalPrompt.messages.map(message => message.content).join('\n\n');
  const lotteryPromptCombined = lotteryPrompt.messages.map(message => message.content).join('\n\n');

  assert.ok(!normalPromptCombined.includes('[本地内容:抽奖结果规则]'));
  assert.ok(lotteryPromptCombined.includes('[本地内容:抽奖结果规则]'));
  assert.ok(lotteryPromptCombined.includes('以下是内部规则,知晓即可'));
  assert.ok(lotteryPromptCombined.includes('系统已强制生成如下11次抽奖结果'));
  assert.doesNotMatch(lotteryPromptCombined, /<%[\s\S]*?%>/);
}

async function testStandaloneFeatureLocalContentBlocksFollowDedicatedToggles(): Promise<void> {
  const baseEnabledMap = {
    'main-api-prompt': true,
    'current-stat-snapshot': true,
    'plot-lottery-rules': true,
    'plot-world-difficulty': true,
    'plot-text-to-image': false,
    'plot-online-mode': false,
    'variable-update-format': true,
    'variable-update-rules': true,
  };

  const enabledMap = applyOnlineModeToStandaloneLocalContent(
    applyTextToImageToStandaloneLocalContent(baseEnabledMap, true),
    true,
  );
  const enabledBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap,
    renderContext: createRenderContext(),
    preset: null,
  });

  assert.ok(enabledBlocks.some(block => block.includes('[本地内容:文生图格式规则]')));
  assert.ok(enabledBlocks.some(block => block.includes('[本地内容:多人联机规则]')));

  const disabledBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap: baseEnabledMap,
    renderContext: createRenderContext(),
    preset: null,
  });

  assert.ok(!disabledBlocks.some(block => block.includes('[本地内容:文生图格式规则]')));
  assert.ok(!disabledBlocks.some(block => block.includes('[本地内容:多人联机规则]')));
}

async function testTextToImageLocalContentAssetsSwitchWithBackend(): Promise<void> {
  const baseEnabledMap = {
    'main-api-prompt': true,
    'plot-text-to-image': false,
    'plot-text-to-image-nai': false,
    'plot-online-mode': false,
  };

  // 生图总开关关着：两条规则都关（AI 不写提示词）
  const off = applyTextToImageToStandaloneLocalContent(baseEnabledMap, false, 'novelai');
  assert.equal(off['plot-text-to-image'], false);
  assert.equal(off['plot-text-to-image-nai'], false);

  // 开 + 后端 NovelAI：只开标签流那条
  const novelAiOn = applyTextToImageToStandaloneLocalContent(baseEnabledMap, true, 'novelai');
  assert.equal(novelAiOn['plot-text-to-image'], false);
  assert.equal(novelAiOn['plot-text-to-image-nai'], true);

  // 开 + 后端 ComfyUI：只开自然语言那条
  const comfyUiOn = applyTextToImageToStandaloneLocalContent(baseEnabledMap, true, 'comfyui');
  assert.equal(comfyUiOn['plot-text-to-image'], true);
  assert.equal(comfyUiOn['plot-text-to-image-nai'], false);

  // 从 NovelAI 切回 ComfyUI：绝不允许两条同时开着
  const switched = applyTextToImageToStandaloneLocalContent(novelAiOn, true, 'comfyui');
  assert.equal(switched['plot-text-to-image'], true);
  assert.equal(switched['plot-text-to-image-nai'], false);
}

async function testNovelAiTextToImageBlockFollowsSelectedBackend(): Promise<void> {
  const baseEnabledMap = {
    'main-api-prompt': true,
    'plot-text-to-image': false,
    'plot-text-to-image-nai': false,
  };

  const novelAiBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap: applyTextToImageToStandaloneLocalContent(baseEnabledMap, true, 'novelai'),
    renderContext: createRenderContext(),
    preset: null,
  });

  assert.ok(novelAiBlocks.some(block => block.includes('[本地内容:文生图格式规则（NovelAI）]')));
  assert.ok(!novelAiBlocks.some(block => block.includes('[本地内容:文生图格式规则]')));
  assert.ok(novelAiBlocks.some(block => block.includes('Danbooru')));

  const comfyUiBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap: applyTextToImageToStandaloneLocalContent(baseEnabledMap, true, 'comfyui'),
    renderContext: createRenderContext(),
    preset: null,
  });

  assert.ok(comfyUiBlocks.some(block => block.includes('[本地内容:文生图格式规则]')));
  assert.ok(!comfyUiBlocks.some(block => block.includes('[本地内容:文生图格式规则（NovelAI）]')));
}

async function testStoredStandaloneLocalContentSettingsHonourNovelAiBackend(): Promise<void> {
  const settings = resolveStoredStandaloneLocalContentSettings({
    storedSettings: { enabledAssets: {} },
    imagePromptEnabled: true,
    imageBackend: 'novelai',
    onlineModeEnabled: false,
  });

  assert.equal(settings.enabledAssets['plot-text-to-image-nai'], true);
  assert.equal(settings.enabledAssets['plot-text-to-image'], false);

  // 老存档迁移：没有 imageBackend 字段时按 ComfyUI 处理，行为与改动前一致
  const legacy = resolveStoredStandaloneLocalContentSettings({
    storedSettings: { enabledAssets: {} },
    imagePromptEnabled: true,
    onlineModeEnabled: false,
  });

  assert.equal(legacy.enabledAssets['plot-text-to-image'], true);
  assert.equal(legacy.enabledAssets['plot-text-to-image-nai'], false);
}

async function testBuildsWorldDifficultyStandaloneLocalContent(): Promise<void> {
  const easiest = buildWorldDifficultyStandaloneLocalContent('最简单');
  const hell = buildWorldDifficultyStandaloneLocalContent('地狱');

  assert.ok(easiest.includes('当前世界难度：最简单'));
  assert.ok(easiest.includes('新手保护优先'));
  assert.ok(hell.includes('当前世界难度：地狱'));
  assert.ok(hell.includes('高压生存'));
  assert.notEqual(easiest, hell);
}

async function testWorldDifficultyBlocksFollowSelectedDifficulty(): Promise<void> {
  const enabledMap = {
    'main-api-prompt': true,
    'current-stat-snapshot': true,
    'plot-lottery-rules': true,
    'plot-world-difficulty': true,
    'plot-text-to-image': false,
    'plot-online-mode': false,
    'variable-update-format': true,
    'variable-update-rules': true,
  };

  const easiestBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap,
    renderContext: createRenderContext({ worldDifficulty: '最简单' }),
    preset: null,
  });
  const hellBlocks = resolveStandaloneLocalContentBlocks({
    route: 'main',
    enabledMap,
    renderContext: createRenderContext({ worldDifficulty: '地狱' }),
    preset: null,
  });

  assert.ok(easiestBlocks.some(block => block.includes('[本地内容:世界难度规则]')));
  assert.ok(easiestBlocks.some(block => block.includes('当前世界难度：最简单')));
  assert.ok(easiestBlocks.some(block => block.includes('新手保护优先')));
  assert.ok(hellBlocks.some(block => block.includes('当前世界难度：地狱')));
  assert.ok(hellBlocks.some(block => block.includes('高压生存')));
  assert.ok(!hellBlocks.some(block => block.includes('新手保护优先')));
}

async function testMainPromptIncludesSelectedWorldDifficultyBlock(): Promise<void> {
  const input = createStandaloneTurnInput({
    worldDifficulty: '困难',
  });

  const prompt = buildMainTurnPrompt(input);

  const promptCombined = prompt.messages.map(message => message.content).join('\n\n');

  assert.ok(promptCombined.includes('[本地内容:世界难度规则]'));
  assert.ok(promptCombined.includes('当前世界难度：困难'));
  assert.ok(promptCombined.includes('资源偏紧'));
}

async function testMainPromptStillRequiresActionOptionsWithoutLocalActionOptionAsset(): Promise<void> {
  const input = createStandaloneTurnInput();
  const prompt = buildMainTurnPrompt(input);
  const systemMessages = collectPromptMessagesByRole(prompt, 'system').join('\n\n');

  assert.ok(systemMessages.includes('<action_options>'));
  assert.ok(systemMessages.includes('3 到 5 行可选行动'));
  assert.ok(!systemMessages.includes('[本地内容:行动选项生成器]'));
}

async function testMainPromptAlwaysIncludesRequiredMainReplyRule(): Promise<void> {
  const input = createStandaloneTurnInput({
    localContentEnabledMap: {
      'main-api-prompt': false,
      'current-stat-snapshot': true,
      'plot-lottery-rules': true,
      'plot-world-difficulty': true,
      'variable-update-format': true,
      'variable-update-rules': true,
    },
  });
  const prompt = buildMainTurnPrompt(input);
  const systemMessages = collectPromptMessagesByRole(prompt, 'system').join('\n\n');

  assert.ok(systemMessages.includes('[本地内容:主回复标签规则]'));
  assert.ok(systemMessages.includes('你必须用 <contenttext>  </contenttext> 标签包裹正文'));
  assert.ok(systemMessages.includes('you should NOT output the update variable commands in the next reply'));
}

async function testMainPromptUsesOrderedMessagesAndStatSnapshotWithoutDuplicatedMappedBlocks(): Promise<void> {
  const input = createStandaloneTurnInput({
    statData: createRenderContext({
      statData: {
        ...createRenderContext().statData,
        世界: {
          ...createRenderContext().statData.世界,
          空间定位: {
            ...createRenderContext().statData.世界.空间定位,
            当前位置: '中国某市-测试地点',
          },
        },
        玩家: {
          ...createRenderContext().statData.玩家,
          姓名: '测试玩家',
          当前目标: '先活下来',
        },
        人物档案: {
          NPC_1: {
            姓名: '测试NPC',
            种族: '人类',
            性别: '女',
            年龄: 20,
            社会身份: {
              职业: '店员',
            },
            关系数据: {
              好感度: 10,
            },
            个人信息: {
              外貌: '短发，神情警惕',
              表性格: '谨慎',
              里性格: '其实很好奇',
              当前想法: '先观察对方',
              当前穿着: '蓝色外套',
              当前位置: '街边小店',
              当前状态: '营业中',
            },
          },
        },
      },
    }).statData as StandaloneLocalTurnInput['statData'],
    messages: [
      createMessage({ message_id: 1, role: 'user', content_text: '第一句', raw_content: '第一句' }),
      createMessage({ message_id: 2, role: 'assistant', content_text: '第二句', raw_content: '第二句' }),
    ],
    latestUserMessage: createMessage({
      message_id: 3,
      role: 'user',
      content_text: '第三句输入',
      raw_content: '第三句输入',
    }),
  });

  const prompt = buildMainTurnPrompt(input);

  assert.ok(Array.isArray(prompt.messages));
  assert.ok(prompt.messages.length > 4);
  assert.equal(prompt.messages[0]?.role, 'system');
  assert.ok(prompt.messages[0]?.content.includes('[原版预设:主系统提示词]'));
  assert.equal(prompt.messages[0]?.content.includes('[当前变量快照 stat_data]'), false);

  const promptCombined = prompt.messages.map(message => `[${message.role}]\n${message.content}`).join('\n\n');
  assert.ok(promptCombined.includes('[当前变量快照 stat_data]'));
  assert.equal(promptCombined.match(/\[当前变量快照 stat_data\]/g)?.length ?? 0, 1);
  assert.ok(promptCombined.includes('[本地内容:[WB]运行时条目]') || promptCombined.includes('[WB]'));
  assert.ok(promptCombined.includes('测试NPC'));
  assert.ok(promptCombined.includes('谨慎'));
  assert.ok(promptCombined.includes('中国某市-测试地点'));
  assert.ok(promptCombined.includes('测试玩家'));
  assert.ok(!promptCombined.includes('[原版预设:Char Description]'));
  assert.ok(!promptCombined.includes('[原版预设:Char Personality]'));
  assert.ok(!promptCombined.includes('[原版预设:Scenario]'));
  assert.ok(!promptCombined.includes('[原版预设:Persona Description]'));
  assert.equal(prompt.messages.at(-1)?.role, 'user');
  assert.equal(prompt.messages.at(-1)?.content, '第三句输入');
}

async function testMainPromptSkipsDuplicatedMappedPresetSections(): Promise<void> {
  const prompt = buildMainTurnPrompt(createStandaloneTurnInput());
  const orderedTitles = prompt.messages
    .map(message => {
      const match = message.content.match(/\[原版预设:([^\]]+)\]/);
      return match?.[1] ?? null;
    })
    .filter((title): title is string => Boolean(title));

  assert.equal(orderedTitles.includes('Char Description'), false);
  assert.equal(orderedTitles.includes('Char Personality'), false);
  assert.equal(orderedTitles.includes('Scenario'), false);
  assert.equal(orderedTitles.includes('Persona Description'), false);
  assert.equal(orderedTitles.includes('Chat History'), false);
}

async function testBuiltInCapuaPresetCarriesRegisteredWorldbookIntoMainPrompt(): Promise<void> {
  const builtInPresets = attachRegisteredWorldbooksToBuiltInPresets(capuaBloodSandPresets);
  assert.equal(builtInPresets.length, 1);

  const capuaPreset = builtInPresets[0]!;
  assert.ok(capuaPreset.localContentEntries?.some(entry => entry.name === '[WB]卡普阿的荣耀：血与沙'));

  const input = createStandaloneTurnInput({
    selectedPreset: capuaPreset,
  });

  const prompt = buildMainTurnPrompt(input);
  const combined = prompt.messages.map(message => `[${message.role}]\n${message.content}`).join('\n\n');

  assert.match(combined, /\[WB\]卡普阿的荣耀：血与沙/);
}

async function testPresetLoaderForceReloadBypassesResolvedCache(): Promise<void> {
  resetStandaloneTestEnvironment();

  const originalCreateElement = browserDocument.createElement;
  const originalHead = (browserDocument as typeof browserDocument & { head?: { appendChild(node: any): void } }).head;
  let loadStep = 0;

  (browserDocument as typeof browserDocument & { head: { appendChild(node: any): void } }).head = {
    appendChild(node: any) {
      loadStep += 1;
      window.__TH1980S_PRESETS__ = [
        {
          id: `preset-${loadStep}`,
          name: `预设-${loadStep}`,
          icon: '🧪',
          category: '测试',
          tags: [],
          description: `第 ${loadStep} 次加载`,
          config: {} as PresetConfig['config'],
        },
      ];
      node.onload?.();
    },
  };

  browserDocument.createElement = ((tagName: string) => {
    if (tagName === 'script') {
      return {
        tagName,
        src: '',
        async: true,
        dataset: {} as Record<string, string>,
        onload: undefined as (() => void) | undefined,
        onerror: undefined as ((error: unknown) => void) | undefined,
        remove() {},
      };
    }

    return originalCreateElement.call(browserDocument, tagName);
  }) as typeof browserDocument.createElement;

  try {
    const first = await loadPresetsBundle(true);
    const second = await loadPresetsBundle(true);

    assert.equal(first[0]?.id, 'preset-1');
    assert.equal(second[0]?.id, 'preset-2');
    assert.equal(getPresets()[0]?.id, 'preset-2');
  } finally {
    browserDocument.createElement = originalCreateElement;
    if (originalHead) {
      (browserDocument as typeof browserDocument & { head: { appendChild(node: any): void } }).head = originalHead;
    }
  }
}

async function testVariableUpdateSecondPassUsesSharedStatBlockAndAssistantBeforeUser(): Promise<void> {
  const input = createStandaloneTurnInput({
    selectedPreset: {
      id: 'variable-pass-order',
      name: '变量更新顺序测试',
      icon: '🧪',
      category: '测试',
      tags: [],
      description: '验证辅助链路顺序。',
      config: {} as PresetConfig['config'],
      localContentEntries: [
        {
          name: '[WB]变量世界书',
          content: '变量更新世界书内容',
          kind: 'worldbook',
          route: 'variable_update',
          enabled: true,
        },
        {
          name: '[mvu_update]变量更新规则',
          content: '变量更新规则正文',
          kind: 'variable_update_rule',
          route: 'variable_update',
          enabled: true,
        },
      ],
    },
  });

  const prompt = buildVariableUpdateSecondPassPrompt({
    statData: input.statData,
    latestUserMessage: input.latestUserMessage,
    assistantContentText: '主回复正文内容',
    messages: input.messages,
    worldDifficulty: input.worldDifficulty,
    localContentEnabledMap: input.localContentEnabledMap,
    localContentBuiltinRouteOverrides: input.localContentBuiltinRouteOverrides,
    selectedPreset: input.selectedPreset,
  });

  assert.equal(prompt.messages[0]?.content.includes('[当前变量快照 stat_data]'), true);

  const assistantIndex = prompt.messages.findIndex(
    message => message.role === 'assistant' && message.content === '主回复正文内容',
  );
  const latestUserIndex = prompt.messages.findIndex(
    message => message.role === 'user' && message.content === input.latestUserMessage.content_text,
  );

  assert.ok(assistantIndex > -1);
  assert.ok(latestUserIndex > assistantIndex);
}

async function testStandaloneRuntimeSessionPersistsFormalContentContext(): Promise<void> {
  clearStandaloneRuntimeState();

  const statData = createRenderContext().statData as StandaloneLocalTurnInput['statData'];
  ensureStandaloneRuntimeBootstrap(statData);

  const preset: PresetConfig = {
    id: 'runtime-context-preset',
    name: '运行时快照预设',
    icon: '🗂️',
    category: '测试分类',
    tags: ['runtime'],
    description: '验证 runtime session 的正式内容上下文字段。',
    config: {} as PresetConfig['config'],
    localContentEntries: [
      {
        name: '[WB]运行时条目',
        content: '世界书正文',
        kind: 'worldbook',
        route: 'main',
        enabled: true,
      },
    ],
  };

  const standaloneLocalContent = resolveStoredStandaloneLocalContentSettings({
    storedSettings: undefined,
    imagePromptEnabled: true,
    onlineModeEnabled: false,
  });

  patchStandaloneRuntimeSessionContext({
    preset,
    standaloneLocalContent,
    sendFullPreset: true,
  });

  syncStandaloneRuntimeSessionStatData(statData, {
    preset,
    standaloneLocalContent,
    sendFullPreset: true,
  });

  const session = loadStandaloneRuntimeSession();
  assert.ok(session);
  assert.equal(session.preset_meta?.id, 'runtime-context-preset');
  assert.equal(session.preset_meta?.name, '运行时快照预设');
  assert.equal(session.prompt_assets?.mode, 'full');
  assert.ok(Array.isArray(session.worldbook_context));
  assert.ok(session.worldbook_context.some(entry => entry.id === 'main-api-prompt'));
  assert.ok(session.worldbook_context.some(entry => entry.kind === 'worldbook'));

  const runtimeContentContext = getStandaloneRuntimeContentContext();
  assert.equal(runtimeContentContext.presetMeta?.id, 'runtime-context-preset');
  assert.equal(runtimeContentContext.promptAssets?.mode, 'full');
  assert.ok(runtimeContentContext.worldbookContext.some(entry => entry.kind === 'worldbook'));
}

async function testStandaloneMainApiOpenAiRequestContract(): Promise<void> {
  let capturedUrl = '';
  let capturedOptions: RequestInit | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedOptions = init;
    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '主 API 回复文本',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const api = {
      ...createDefaultApiConfig(),
      apiurl: 'https://example.com/v1',
      key: 'test-key',
      model: 'gpt-test',
      source: 'openai_compatible' as const,
    };

    const result = await requestStandaloneMainApiText({
      api,
      prompt: {
        systemPrompt: '系统规则',
        userPrompt: '用户输入',
      },
      requestId: 'main-api-contract-openai',
    });

    assert.equal(result, '主 API 回复文本');
    assert.equal(capturedUrl, 'https://example.com/v1/chat/completions');
    assert.equal(capturedOptions?.method, 'POST');
    assert.equal((capturedOptions?.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.equal((capturedOptions?.headers as Record<string, string>).Authorization, 'Bearer test-key');

    const body = JSON.parse(String(capturedOptions?.body ?? '{}'));
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.temperature, 1);
    assert.deepEqual(body.messages, [
      { role: 'system', content: '系统规则' },
      { role: 'user', content: '用户输入' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneProviderCoreStreamingRequestContract(): Promise<void> {
  let capturedOptions: RequestInit | undefined;
  let latestPartialText = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedOptions = init;
    return createMockStreamingResponse([
      'data: {"choices":[{"delta":{"content":"<UpdateVariable>"}}]}\n',
      'data: {"choices":[{"delta":{"content":"[]"}}]}\n',
      'data: {"choices":[{"delta":{"content":"</UpdateVariable>"}}]}\n',
      'data: [DONE]\n',
    ]);
  }) as typeof fetch;

  try {
    const reply = await requestStandaloneProviderTextCore({
      api: {
        apiurl: 'https://assistant-stream.example.com/v1/chat/completions',
        key: 'assistant-stream-key',
        model: 'assistant-stream-model',
        source: 'openai_compatible',
      },
      prompt: {
        messages: [{ role: 'user', content: '请输出变量更新' }],
      },
      signal: new AbortController().signal,
      logPrefix: '[StandaloneProviderCoreTest]',
      onPartialText(text) {
        latestPartialText = text;
      },
    });

    const body = JSON.parse(String(capturedOptions?.body ?? '{}'));
    assert.equal(body.stream, true);
    assert.equal(reply.text, '<UpdateVariable>[]</UpdateVariable>');
    assert.equal(latestPartialText, '<UpdateVariable>[]</UpdateVariable>');
    assert.equal(reply.debugTrace.transport_mode, 'streaming');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneProviderCoreSupportsApiWithoutKey(): Promise<void> {
  let capturedOptions: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedOptions = init;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '无密钥接口回复',
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }) as typeof fetch;

  try {
    const api = {
      apiurl: 'https://no-key.example.com/v1/chat/completions',
      key: '',
      model: 'no-key-model',
      source: 'openai_compatible' as const,
    };

    assert.equal(hasCompleteStandaloneProviderApiConfig(api), true);

    const reply = await requestStandaloneProviderTextCore({
      api,
      prompt: {
        messages: [{ role: 'user', content: '无密钥请求' }],
      },
      signal: new AbortController().signal,
      logPrefix: '[StandaloneProviderCoreNoKeyTest]',
    });

    const headers = capturedOptions?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal('Authorization' in headers, false);
    assert.equal(reply.text, '无密钥接口回复');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneProviderCoreFallsBackWhenStreamingReturnsWholeJson(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createMockStreamingResponse([
      JSON.stringify({
        choices: [
          {
            message: {
              content: '<UpdateVariable>[{"op":"replace","path":"/玩家/姓名","value":"整包回退成功"}]</UpdateVariable>',
            },
          },
        ],
      }),
    ])) as typeof fetch;

  try {
    const reply = await requestStandaloneProviderTextCore({
      api: {
        apiurl: 'https://assistant-fallback.example.com/v1/chat/completions',
        key: 'assistant-fallback-key',
        model: 'assistant-fallback-model',
        source: 'openai_compatible',
      },
      prompt: {
        messages: [{ role: 'user', content: '请输出变量更新' }],
      },
      signal: new AbortController().signal,
      logPrefix: '[StandaloneProviderCoreFallbackTest]',
      onPartialText() {},
    });

    assert.match(reply.text, /整包回退成功/);
    assert.equal(reply.debugTrace.transport_mode, 'streaming');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testStandaloneOpenAiApiUrlNormalization(): void {
  assert.equal(normalizeStandaloneOpenAiApiUrl('https://example.com/v1'), 'https://example.com/v1');
  assert.equal(normalizeStandaloneOpenAiApiUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(normalizeStandaloneOpenAiApiUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1');
  assert.equal(normalizeStandaloneOpenAiApiUrl('https://example.com/v1/models'), 'https://example.com/v1');
  assert.equal(normalizeStandaloneOpenAiApiUrl('https://generativelanguage.googleapis.com/v1beta/models'), '');

  assert.equal(
    normalizeStandaloneOpenAiChatCompletionsApiUrl('https://example.com/v1'),
    'https://example.com/v1/chat/completions',
  );
  assert.equal(
    normalizeStandaloneOpenAiChatCompletionsApiUrl('https://example.com/v1/chat/completions'),
    'https://example.com/v1/chat/completions',
  );
  assert.equal(
    normalizeStandaloneOpenAiChatCompletionsApiUrl('https://example.com/v1/models'),
    'https://example.com/v1/chat/completions',
  );

  assert.equal(normalizeStandaloneOpenAiModelsApiUrl('https://example.com/v1'), 'https://example.com/v1/models');
  assert.equal(normalizeStandaloneOpenAiModelsApiUrl('https://example.com/v1/'), 'https://example.com/v1/models');
  assert.equal(
    normalizeStandaloneOpenAiModelsApiUrl('https://example.com/v1/chat/completions'),
    'https://example.com/v1/models',
  );
  assert.equal(normalizeStandaloneOpenAiModelsApiUrl('https://example.com/v1/models'), 'https://example.com/v1/models');
}

async function testStandaloneMainApiRequestNormalizesRuntimeApiUrl(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';

  globalThis.fetch = (async (input: string | URL | Request) => {
    capturedUrl = String(input);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '运行时归一化成功',
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }) as typeof fetch;

  try {
    const result = await requestStandaloneMainApiText({
      api: {
        ...createDefaultApiConfig(),
        apiurl: 'https://example.com/v1',
        key: 'runtime-key',
        model: 'runtime-model',
        source: 'openai_compatible',
      },
      prompt: {
        systemPrompt: '系统规则',
        userPrompt: '用户输入',
      },
      requestId: 'runtime-normalize-openai',
    });

    assert.equal(result, '运行时归一化成功');
    assert.equal(capturedUrl, 'https://example.com/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testOpenAiCompatibleModelsUseSillyTavernBackendWhenAvailable(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalSillyTavern = (globalThis as any).SillyTavern;
  let capturedUrl = '';
  let capturedBody: any;

  (globalThis as any).SillyTavern = {
    getRequestHeaders: () => ({
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': 'csrf-test',
    }),
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body ?? '{}'));
    return createMockFetchResponse({
      jsonData: {
        data: [{ id: 'backend-model' }],
      },
    });
  }) as typeof fetch;

  try {
    const models = await fetchOpenAiCompatibleModelIds({
      apiurl: 'https://example.com/v1/chat/completions',
      key: 'backend-key',
    });

    assert.deepEqual(models, ['backend-model']);
    assert.equal(capturedUrl, '/api/backends/chat-completions/status');
    assert.equal(capturedBody.chat_completion_source, 'custom');
    assert.equal(capturedBody.custom_url, 'https://example.com/v1');
    assert.equal(capturedBody.custom_include_headers, 'Authorization: Bearer backend-key');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).SillyTavern = originalSillyTavern;
  }
}

async function testOpenAiCompatibleModelsFallbackToDirectFetch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalSillyTavern = (globalThis as any).SillyTavern;
  let capturedUrl = '';
  let capturedHeaders: any;

  delete (globalThis as any).SillyTavern;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers;
    return createMockFetchResponse({
      jsonData: {
        data: [{ id: 'direct-model' }],
      },
    });
  }) as typeof fetch;

  try {
    const models = await fetchOpenAiCompatibleModelIds({
      apiurl: 'https://example.com/v1',
      key: 'direct-key',
    });

    assert.deepEqual(models, ['direct-model']);
    assert.equal(capturedUrl, 'https://example.com/v1/models');
    assert.equal(capturedHeaders.Authorization, 'Bearer direct-key');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).SillyTavern = originalSillyTavern;
  }
}

function testNormalizeApiConfigForcesOpenAiCompatibleMode(): void {
  const config = normalizeApiConfig({
    apiurl: 'https://example.com/v1',
    key: 'legacy-key',
    model: 'legacy-model',
    source: 'openai_compatible',
  });

  assert.equal(config.source, 'openai_compatible');
  assert.equal(config.apiurl, 'https://example.com/v1');

  const migratedGoogleConfig = normalizeApiConfig({
    apiurl: 'https://generativelanguage.googleapis.com/v1beta/models',
    key: 'google-key',
    model: 'gemini-test',
  });

  assert.equal(migratedGoogleConfig.source, 'openai_compatible');
  assert.equal(migratedGoogleConfig.apiurl, '');
}

async function testStandaloneMainApiAbortContract(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    void input;
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted-by-test'));
        });
      }
    });
  }) as typeof fetch;

  try {
    const api = {
      ...createDefaultApiConfig(),
      apiurl: 'https://example.com/v1',
      key: 'abort-key',
      model: 'abort-model',
      source: 'openai_compatible' as const,
    };

    const pending = requestStandaloneMainApiText({
      api,
      prompt: {
        systemPrompt: '系统规则',
        userPrompt: '用户输入',
      },
      requestId: 'abort-main-api',
    });

    assert.equal(cancelStandaloneMainApiRequest('abort-main-api'), true);
    await assert.rejects(pending, error => error instanceof Error && error.message === 'standalone_main_api_aborted');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnAbortContract(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    void input;
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted-by-test'));
        });
      }
    });
  }) as typeof fetch;

  try {
    const pending = runStandaloneLocalTurn(createStandaloneTurnInput());
    cancelStandaloneLocalTurn();
    await assert.rejects(pending, error => error instanceof Error && error.message === 'standalone_local_turn_aborted');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneMainApiHttpErrorIncludesRawDetails(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createMockFetchResponse({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      textData: '{"error":"invalid_request"}',
    })) as typeof fetch;

  try {
    const api = {
      ...createDefaultApiConfig(),
      apiurl: 'https://example.com/v1',
      key: 'error-key',
      model: 'error-model',
      source: 'openai_compatible' as const,
    };

    await assert.rejects(
      requestStandaloneMainApiText({
        api,
        prompt: {
          systemPrompt: '系统规则',
          userPrompt: '用户输入',
        },
        requestId: 'http-error-main-api',
      }),
      error =>
        error instanceof Error &&
        error.message.includes('HTTP 400 Bad Request') &&
        error.message.includes('{"error":"invalid_request"}'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnSkipsVariableUpdateWhenMainApiFails(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let variableUpdateRequestCount = 0;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (isStandaloneVariableUpdateRequest(body)) {
      variableUpdateRequestCount += 1;
      throw new Error('variable update should not run when main api fails');
    }

    return createMockFetchResponse({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      textData: '{"error":"main_failed"}',
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      runStandaloneLocalTurn(
        createStandaloneTurnInput({
          assistantApis: [
            {
              ...createDefaultApiConfig(),
              apiurl: 'https://assistant-after-main-fail.example.com/v1/chat/completions',
              key: 'assistant-after-main-fail-key',
              model: 'assistant-after-main-fail-model',
              source: 'openai_compatible',
            },
          ],
        }),
      ),
      error => error instanceof Error && error.message.includes('HTTP 502 Bad Gateway'),
    );
    assert.equal(variableUpdateRequestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnSkipsVariableUpdateWhenMainReplyHasNoContent(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let variableUpdateRequestCount = 0;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (isStandaloneVariableUpdateRequest(body)) {
      variableUpdateRequestCount += 1;
      throw new Error('variable update should not run when main reply has no content');
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content:
                '<UpdateVariable><Analysis>main only update</Analysis><JSONPatch>[]</JSONPatch></UpdateVariable>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      runStandaloneLocalTurn(
        createStandaloneTurnInput({
          assistantApis: [
            {
              ...createDefaultApiConfig(),
              apiurl: 'https://assistant-after-empty-main.example.com/v1/chat/completions',
              key: 'assistant-after-empty-main-key',
              model: 'assistant-after-empty-main-model',
              source: 'openai_compatible',
            },
          ],
        }),
      ),
      error => error instanceof Error && error.message.includes('主 API 未返回正文内容'),
    );
    assert.equal(variableUpdateRequestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnUsesAssistantApiFallbackForSecondPass(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<{ url: string; body: any }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    requestBodies.push({ url, body });

    if (isStandaloneVariableUpdateRequest(body)) {
      if (url.includes('assistant-a.example.com')) {
        throw new Error('assistant-a failed');
      }

      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"二阶段补写成功"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>第一段正文</contenttext><action_options>1. 继续观察</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-a.example.com/v1/chat/completions',
            key: 'assistant-a-key',
            model: 'assistant-a-model',
            source: 'openai_compatible',
          },
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-b.example.com/v1/chat/completions',
            key: 'assistant-b-key',
            model: 'assistant-b-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    assert.equal(outcome.assistantMessage.content_text, '第一段正文');
    assert.equal(outcome.assistantMessage.variable_update_status, 'running');
    assert.equal(outcome.usedApiLabel, 'openai_compatible:test-model');

    const finalized = await outcome.finalizeVariableUpdate;

    assert.equal(finalized.variableUpdateApplied, true);
    assert.equal(finalized.variableUpdateWarning, null);
    assert.equal(finalized.variableUpdateStatus, 'success');
    assert.equal(finalized.nextStatData.玩家.姓名, '二阶段补写成功');
    assert.match(finalized.usedApiLabel, /openai_compatible:test-model/);
    assert.match(finalized.usedApiLabel, /openai_compatible:assistant-b-model/);

    const secondPassRequests = requestBodies.filter(item => isStandaloneVariableUpdateRequest(item.body));
    assert.equal(secondPassRequests.length, 2);
    assert.equal(secondPassRequests[0]?.url, 'https://assistant-a.example.com/v1/chat/completions');
    assert.equal(secondPassRequests[1]?.url, 'https://assistant-b.example.com/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnIgnoresMainApiUpdateVariableAndStillUsesAssistantSecondPass(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<{ url: string; body: any }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    requestBodies.push({ url, body });

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"辅助接口最终结果"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content:
                '<contenttext>主接口正文</contenttext><UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"主接口不应生效"}]</JSONPatch></UpdateVariable><action_options>1. 继续观察</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-only.example.com/v1/chat/completions',
            key: 'assistant-key',
            model: 'assistant-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    assert.equal(outcome.assistantMessage.content_text, '主接口正文');
    assert.equal(outcome.assistantMessage.variable_update_status, 'running');

    const finalized = await outcome.finalizeVariableUpdate;

    assert.equal(finalized.nextStatData.玩家.姓名, '辅助接口最终结果');
    assert.equal(finalized.variableUpdateApplied, true);
    assert.equal(finalized.variableUpdateWarning, null);
    assert.equal(finalized.variableUpdateStatus, 'success');
    assert.ok(!outcome.assistantMessage.raw_content.includes('主接口不应生效'));
    assert.ok(finalized.assistantMessage.raw_content.includes('辅助接口最终结果'));

    const secondPassRequests = requestBodies.filter(item => isStandaloneVariableUpdateRequest(item.body));
    assert.equal(secondPassRequests.length, 1);
    assert.equal(secondPassRequests[0]?.url, 'https://assistant-only.example.com/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnExposesMainReplyBeforeVariableUpdateCompletes(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let resolveSecondPassResponse: ((value: Response) => void) | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return await new Promise<Response>(resolve => {
        resolveSecondPassResponse = resolve;
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>先显示这段正文</contenttext><action_options>1. 继续观察</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const pendingOutcome = runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-delayed.example.com/v1/chat/completions',
            key: 'assistant-delayed-key',
            model: 'assistant-delayed-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    const outcome = await pendingOutcome;
    assert.equal(outcome.assistantMessage.content_text, '先显示这段正文');
    assert.equal(outcome.assistantMessage.variable_update_status, 'running');

    let finalized = false;
    const finalizedPromise = outcome.finalizeVariableUpdate.then(result => {
      finalized = true;
      return result;
    });

    await flushScheduledUiEffects();
    assert.equal(finalized, false);
    assert.ok(resolveSecondPassResponse);

    const secondPassResolver: (value: Response) => void =
      resolveSecondPassResponse ??
      (() => {
        throw new Error('expected delayed second-pass resolver');
      });

    secondPassResolver(
      createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"延迟完成"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      }),
    );

    const finalizedOutcome = await finalizedPromise;
    assert.equal(finalizedOutcome.variableUpdateStatus, 'success');
    assert.equal(finalizedOutcome.nextStatData.玩家.姓名, '延迟完成');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnRetriesVariableUpdateWhenPatchApplyFails(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const secondPassRequestBodies: any[] = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      secondPassRequestBodies.push(body);

      // 第一次：引用快照里不存在的待办条目（复现 Parent path does not exist 报错）。
      // 第二次：修正为对现有字段的合法 replace。
      const isFirstAttempt = secondPassRequestBodies.length === 1;
      const patchText = isFirstAttempt
        ? '{"op":"replace","path":"/玩家/记事本/待办事项/不存在的待办条目/状态","value":"已完成"}'
        : '{"op":"replace","path":"/玩家/姓名","value":"重试成功"}';

      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content: `<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[${patchText}]</JSONPatch></UpdateVariable>`,
              },
            },
          ],
        },
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>正文内容</contenttext><action_options>1. 继续</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-retry.example.com/v1/chat/completions',
            key: 'assistant-retry-key',
            model: 'assistant-retry-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    const finalized = await outcome.finalizeVariableUpdate;

    // 重试后成功应用，不再整批作废
    assert.equal(finalized.variableUpdateStatus, 'success');
    assert.equal(finalized.variableUpdateWarning, null);
    assert.equal(finalized.nextStatData.玩家.姓名, '重试成功');

    // 恰好请求了两次（首次 + 携带错误回执的重试）
    assert.equal(secondPassRequestBodies.length, 2);

    // 重试请求里注入了失败原因与原补丁的纠错回执
    const retryMessages = secondPassRequestBodies[1]?.messages as Array<{ content?: string }>[];
    const retrySystemPrompt = retryMessages?.find(message => message.content?.includes('[Meta.System]'))?.content ?? '';
    assert.ok(retrySystemPrompt.includes('补丁纠错重试'), '重试请求应包含纠错回执指令');
    assert.ok(retrySystemPrompt.includes('不存在的待办条目'), '重试请求应包含失败路径');
    assert.ok(retrySystemPrompt.includes('Parent path does not exist'), '重试请求应包含失败原因');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnDoesNotRetryForeverWhenPatchKeepsFailing(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let secondPassRequestCount = 0;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      secondPassRequestCount += 1;
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/记事本/待办事项/始终不存在/状态","value":"已完成"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>正文内容</contenttext><action_options>1. 继续</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-retry-limit.example.com/v1/chat/completions',
            key: 'assistant-retry-limit-key',
            model: 'assistant-retry-limit-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    const finalized = await outcome.finalizeVariableUpdate;

    // 重试额度用尽后维持「整批作废 + 警告」语义，不会无限重试
    assert.equal(finalized.variableUpdateStatus, 'failed');
    assert.ok(finalized.variableUpdateWarning?.includes('Parent path does not exist'));
    assert.equal(secondPassRequestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnStreamsPartialMainReplyBeforeCompletion(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const streamedSnapshots: string[] = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"流式收尾成功"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"<contenttext>先"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"显示"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"正文</contenttext><summary>阶段总结</summary>"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      },
    );
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn({
      ...createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-stream.example.com/v1/chat/completions',
            key: 'assistant-stream-key',
            model: 'assistant-stream-model',
            source: 'openai_compatible',
          },
        ],
      }),
      onMainReplyPartialText: text => {
        streamedSnapshots.push(text);
      },
    });

    assert.ok(streamedSnapshots.length >= 2);
    assert.equal(streamedSnapshots[0], '<contenttext>先');
    assert.equal(
      streamedSnapshots[streamedSnapshots.length - 1],
      '<contenttext>先显示正文</contenttext><summary>阶段总结</summary>',
    );
    assert.equal(outcome.assistantMessage.content_text, '先显示正文');
    assert.equal(outcome.assistantMessage.summary_content, '阶段总结');

    const finalized = await outcome.finalizeVariableUpdate;
    assert.equal(finalized.variableUpdateStatus, 'success');
    assert.equal(finalized.nextStatData.玩家.姓名, '流式收尾成功');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnCapturesDebugTraceForBothPasses(): Promise<void> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        textData: JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>trace second pass</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"调试记录已补齐"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        }),
      });
    }

    return createMockFetchResponse({
      textData: JSON.stringify({
        choices: [
          {
            message: {
              content: '<contenttext>调试页正文</contenttext><summary>调试页摘要</summary>',
            },
          },
        ],
      }),
    });
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-debug.example.com/v1/chat/completions',
            key: 'assistant-debug-key',
            model: 'assistant-debug-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    assert.ok(outcome.assistantMessage.debug_trace?.main_pass);
    assert.equal(outcome.assistantMessage.debug_trace?.main_pass?.request_messages[0]?.role, 'system');
    assert.match(outcome.assistantMessage.debug_trace?.main_pass?.request_body_text ?? '', /"messages":\[/);
    assert.match(outcome.assistantMessage.debug_trace?.main_pass?.raw_response_text ?? '', /调试页正文/);
    assert.equal(
      outcome.assistantMessage.debug_trace?.main_pass?.extracted_text,
      '<contenttext>调试页正文</contenttext><summary>调试页摘要</summary>',
    );

    const finalized = await outcome.finalizeVariableUpdate;

    assert.ok(finalized.assistantMessage.debug_trace?.main_pass);
    assert.ok(finalized.assistantMessage.debug_trace?.variable_update_pass);
    assert.equal(finalized.assistantMessage.debug_trace?.variable_update_pass?.request_messages.at(-1)?.role, 'user');
    assert.match(
      finalized.assistantMessage.debug_trace?.variable_update_pass?.request_body_text ?? '',
      /assistant-debug-model/,
    );
    assert.match(
      finalized.assistantMessage.debug_trace?.variable_update_pass?.raw_response_text ?? '',
      /调试记录已补齐/,
    );
    assert.match(finalized.assistantMessage.raw_content, /调试记录已补齐/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneMessageActionsProjectStreamingPreviewWithoutMutatingStatData(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;

  // 这条测的是「流式预览期间不许动真实变量」，先种一份已知的变量快照才有东西可对照
  // （不种的话读出来是空名字，那条断言等于没测）。
  ensureStandaloneRuntimeBootstrap(createRenderContext().statData as StandaloneLocalTurnInput['statData']);

  // 假请求要「正文片段先到、[DONE] 一直吊着不吐」。整段一次读完的话，
  // 断言还没跑这一轮就已经收尾（流式投影层被清掉），只能读到 undefined。
  // 吊住之后「正文已到、流还没结束」这个中间态就稳定可观察，不用赌 flush 几次。
  let releaseStreamEnd: (() => void) | null = null;
  let streamEndReleased = false;
  const holdStreamEnd = new Promise<void>(resolve => {
    releaseStreamEnd = resolve;
  });
  const releaseMainReplyStream = () => {
    if (streamEndReleased) {
      return;
    }

    streamEndReleased = true;
    releaseStreamEnd?.();
  };

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"动作流式最终成功"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    const encoder = new TextEncoder();
    const streamChunks = [
      'data: {"choices":[{"delta":{"content":"<contenttext>流式"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文</contenttext><summary>临时总结</summary>"}}]}\n\n',
    ];
    let deliveredChunkCount = 0;

    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (deliveredChunkCount < streamChunks.length) {
            controller.enqueue(encoder.encode(streamChunks[deliveredChunkCount]));
            deliveredChunkCount += 1;
            return;
          }

          await holdStreamEnd;
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      },
    );
  }) as typeof fetch;

  let pendingSend: Promise<boolean> | null = null;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-stream.example.com/v1/chat/completions',
      key: 'main-stream-key',
      model: 'main-stream-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-stream.example.com/v1/chat/completions',
        key: 'assistant-stream-key',
        model: 'assistant-stream-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    const sendPromise = actions.sendStandaloneUserMessage('请继续剧情', 'streaming_preview_test');
    pendingSend = sendPromise;
    // 先让两段正文片段流进来
    await flushScheduledUiEffects();
    // 🔴 流式投影是「120ms 防抖」之后才刷到界面上的，只 flush 微任务等不到它，
    // 必须真等过那个防抖窗口。用模块加载时抓死的定时器，免得被别的测试改过的 setTimeout 影响。
    await new Promise<void>(resolve => {
      standaloneTestSetTimeout(resolve, 150);
    });

    assert.equal(messagesStore.streamingRecord?.content_text, '流式正文');
    assert.equal(messagesStore.streamingRecord?.summary_content, '临时总结');
    assert.equal(messagesStore.streamingRecord?.is_streaming, true);
    assert.equal(loadStandaloneStatData().玩家.姓名, '测试玩家');

    // 中间态断言完了，放行 [DONE] 让这一轮正常收尾。
    releaseMainReplyStream();

    const sendResult = await sendPromise;
    pendingSend = null;
    assert.equal(sendResult, true);
    assert.equal(messagesStore.streamingRecord, null);

    const lastAssistantMessage = messagesStore.messages
      .filter(message => message.role === 'assistant')
      .slice()
      .reverse()[0];
    assert.equal(lastAssistantMessage?.content_text, '流式正文');
    assert.equal(lastAssistantMessage?.summary_content, '临时总结');
    assert.equal(lastAssistantMessage?.variable_update_status, 'success');
    assert.equal(loadStandaloneStatData().玩家.姓名, '动作流式最终成功');
  } finally {
    // 断言失败时这一轮还在跑：先放行、再取消。不收拾干净它会一直占着模块级的
    // 「正在生成」状态，后面所有回合测试都会报「已有独立模式生成任务正在进行中」。
    releaseMainReplyStream();

    if (pendingSend) {
      pendingSend.catch(() => {});
      cancelStandaloneLocalTurn();
      await flushScheduledUiEffects();
    }

    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnAbortAfterMainReplyStillRejectsFinalize(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let resolveSecondPassResponse: ((value: Response) => void) | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return await new Promise<Response>((resolve, reject) => {
        resolveSecondPassResponse = resolve;
        // 真实 fetch 收到取消信号会立刻中断，假请求也必须照做。
        // 少了这段，这条测试会一直等一个永远不来的结果，把后面所有测试一起拖死。
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted-by-test')));
        });
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>正文先到</contenttext><action_options>1. 继续观察</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(
      createStandaloneTurnInput({
        assistantApis: [
          {
            ...createDefaultApiConfig(),
            apiurl: 'https://assistant-delayed.example.com/v1/chat/completions',
            key: 'assistant-delayed-key',
            model: 'assistant-delayed-model',
            source: 'openai_compatible',
          },
        ],
      }),
    );

    assert.equal(outcome.assistantMessage.content_text, '正文先到');
    assert.equal(outcome.assistantMessage.variable_update_status, 'running');
    assert.equal(resolveSecondPassResponse, null);
    await flushScheduledUiEffects();
    assert.ok(resolveSecondPassResponse);

    cancelStandaloneLocalTurn();

    await assert.rejects(
      outcome.finalizeVariableUpdate,
      error => error instanceof Error && /aborted/i.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneLocalTurnMarksSkippedWhenAssistantApiMissing(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>只有主回复</contenttext>',
            },
          },
        ],
      },
    })) as typeof fetch;

  try {
    const outcome = await runStandaloneLocalTurn(createStandaloneTurnInput());
    const finalized = await outcome.finalizeVariableUpdate;

    assert.equal(outcome.assistantMessage.variable_update_status, 'running');
    assert.equal(finalized.variableUpdateApplied, false);
    assert.equal(finalized.variableUpdateStatus, 'failed');
    assert.match(finalized.variableUpdateWarning ?? '', /未找到已保存且完整可用的辅助 API 配置/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testManualRefreshLatestAssistantVariableUpdateRunsSecondPass(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (!isStandaloneVariableUpdateRequest(body)) {
      throw new Error('expected variable update second pass request');
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content:
                '<UpdateVariable><Analysis>only english analysis here</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"手动刷新后结果"}]</JSONPatch></UpdateVariable>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main.example.com/v1/chat/completions',
      key: 'main-key',
      model: 'main-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant.example.com/v1/chat/completions',
        key: 'assistant-key',
        model: 'assistant-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    messagesStore.appendStandaloneMessage({
      role: 'user',
      raw_content: '我想继续推进剧情',
      content_text: '我想继续推进剧情',
      formatted: '我想继续推进剧情',
      action_options: [],
    });
    const assistantMessage = messagesStore.appendStandaloneMessage({
      role: 'assistant',
      raw_content: '<contenttext>这里是现有正文</contenttext>',
      content_text: '这里是现有正文',
      formatted: '这里是现有正文',
      action_options: [],
      variable_update_status: 'failed',
      variable_update_warning: '旧错误',
    });

    const refreshed = await actions.refreshLatestAssistantVariableUpdate();
    assert.equal(refreshed, true);

    const updatedMessage = messagesStore.getMessage(assistantMessage.message_id);
    assert.equal(updatedMessage?.variable_update_status, 'success');
    assert.equal(updatedMessage?.variable_update_warning, null);
    assert.ok(updatedMessage?.raw_content.includes('手动刷新后结果'));

    const statData = loadStandaloneStatData();
    assert.equal(statData.玩家.姓名, '手动刷新后结果');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testManualRefreshLatestAssistantVariableUpdateTimeoutClearsRunningState(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    void input;
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted-by-test')));
        });
      }
    });
  }) as typeof fetch;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-timeout.example.com/v1/chat/completions',
      key: 'main-timeout-key',
      model: 'main-timeout-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-timeout.example.com/v1/chat/completions',
        key: 'assistant-timeout-key',
        model: 'assistant-timeout-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    const originalSetTimeout = globalThis.setTimeout;
    const originalWindowSetTimeout = window.setTimeout;
    const fastTimeout = ((handler: TimerHandler, _timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;

    globalThis.setTimeout = fastTimeout;
    window.setTimeout = fastTimeout;

    messagesStore.appendStandaloneMessage({
      role: 'user',
      raw_content: '我想继续推进剧情',
      content_text: '我想继续推进剧情',
      formatted: '我想继续推进剧情',
      action_options: [],
    });
    const assistantMessage = messagesStore.appendStandaloneMessage({
      role: 'assistant',
      raw_content: '<contenttext>这里是现有正文</contenttext>',
      content_text: '这里是现有正文',
      formatted: '这里是现有正文',
      action_options: [],
      variable_update_status: 'failed',
      variable_update_warning: '旧错误',
    });

    try {
      const refreshed = await actions.refreshLatestAssistantVariableUpdate('manual_variable_refresh_timeout');
      assert.equal(refreshed, false);
      await flushScheduledUiEffects(8);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      window.setTimeout = originalWindowSetTimeout;
    }

    const updatedMessage = messagesStore.getMessage(assistantMessage.message_id);
    assert.equal(updatedMessage?.variable_update_status, 'failed');
    assert.equal(messagesStore.standaloneAssistantGenerationBusy, false);
    assert.equal(messagesStore.hasRunningVariableUpdate, false);
    assert.equal(messagesStore.isStandaloneGenerationLocked, false);
    assert.match(updatedMessage?.variable_update_warning ?? '', /变量更新补写超时/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneResendPrefersSelectedUserMessageSnapshot(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;
  const expectedSnapshot = createArchiveStatData('重发前角色');
  const runtimeStatData = createArchiveStatData('当前运行时角色');
  let mainRequestBody: any = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>resend second pass</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"重发后角色"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    mainRequestBody = body;
    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: createAssistantReply('重发后的正文', '重发前角色'),
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const notificationStore = useNotificationStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-resend.example.com/v1/chat/completions',
      key: 'main-resend-key',
      model: 'main-resend-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-resend.example.com/v1/chat/completions',
        key: 'assistant-resend-key',
        model: 'assistant-resend-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    syncStandaloneRuntimeSessionStatData(expectedSnapshot, {
      preset: null,
      standaloneLocalContent: settingsStore.standaloneLocalContent,
      sendFullPreset: true,
    });

    const userMessage = messagesStore.appendStandaloneMessage({
      role: 'user',
      raw_content: '请重新发送这一层',
      content_text: '请重新发送这一层',
      formatted: '请重新发送这一层',
      action_options: [],
      stat_data_snapshot: expectedSnapshot,
    });
    messagesStore.appendStandaloneMessage({
      role: 'assistant',
      raw_content: createAssistantReply('旧回复正文', '旧回复角色'),
      content_text: '旧回复正文',
      formatted: '旧回复正文',
      action_options: ['1. 旧动作'],
      stat_data_snapshot: createArchiveStatData('旧回复角色'),
      variable_update_status: 'success',
    });

    syncStandaloneRuntimeSessionStatData(runtimeStatData, {
      preset: null,
      standaloneLocalContent: settingsStore.standaloneLocalContent,
      sendFullPreset: true,
    });

    const resendPromise = actions.resend(userMessage.message_id);
    notificationStore.resolveConfirm(true);
    const resent = await resendPromise;

    assert.equal(resent, true);
    assert.ok(mainRequestBody);
    const serializedMainMessages = JSON.stringify(mainRequestBody.messages);
    assert.match(serializedMainMessages, /请重新发送这一层/);
    assert.match(serializedMainMessages, /重发前角色/);
    assert.doesNotMatch(serializedMainMessages, /当前运行时角色/);

    const resentUser = messagesStore.messages.find(
      message => message.role === 'user' && message.raw_content === '请重新发送这一层',
    );
    assert.ok(resentUser);
    assert.equal(resentUser?.stat_data_snapshot?.玩家?.姓名, '重发前角色');
    assert.equal(loadStandaloneStatData().玩家.姓名, '重发后角色');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneRegeneratePrefersSelectedAssistantMessageSnapshot(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;
  const userSnapshot = createArchiveStatData('生成前角色');
  const assistantSnapshot = createArchiveStatData('目标AI快照');
  const runtimeStatData = createArchiveStatData('当前运行时AI角色');
  let mainRequestBody: any = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>regenerate second pass</Analysis><JSONPatch>[{"op":"replace","path":"/玩家/姓名","value":"重新生成后角色"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    mainRequestBody = body;
    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: createAssistantReply('重新生成正文', '目标AI快照'),
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const notificationStore = useNotificationStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-regenerate.example.com/v1/chat/completions',
      key: 'main-regenerate-key',
      model: 'main-regenerate-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-regenerate.example.com/v1/chat/completions',
        key: 'assistant-regenerate-key',
        model: 'assistant-regenerate-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    syncStandaloneRuntimeSessionStatData(userSnapshot, {
      preset: null,
      standaloneLocalContent: settingsStore.standaloneLocalContent,
      sendFullPreset: true,
    });

    messagesStore.appendStandaloneMessage({
      role: 'user',
      raw_content: '请重新生成上一条回复',
      content_text: '请重新生成上一条回复',
      formatted: '请重新生成上一条回复',
      action_options: [],
      stat_data_snapshot: userSnapshot,
    });
    const assistantMessage = messagesStore.appendStandaloneMessage({
      role: 'assistant',
      raw_content: createAssistantReply('旧AI正文', '目标AI快照'),
      content_text: '旧AI正文',
      formatted: '旧AI正文',
      action_options: ['1. 旧AI动作'],
      stat_data_snapshot: assistantSnapshot,
      variable_update_status: 'success',
    });

    syncStandaloneRuntimeSessionStatData(runtimeStatData, {
      preset: null,
      standaloneLocalContent: settingsStore.standaloneLocalContent,
      sendFullPreset: true,
    });

    const regeneratePromise = actions.regenerate(assistantMessage.message_id);
    notificationStore.resolveConfirm(true);
    const regenerated = await regeneratePromise;

    assert.equal(regenerated, true);
    assert.ok(mainRequestBody);
    assert.match(JSON.stringify(mainRequestBody.messages), /目标AI快照/);
    assert.doesNotMatch(JSON.stringify(mainRequestBody.messages), /当前运行时AI角色/);
    assert.equal(loadStandaloneStatData().玩家.姓名, '重新生成后角色');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneDeleteBlocksFormalDeletionWithoutSnapshot(): Promise<void> {
  resetStandaloneTestEnvironment();

  const settingsStore = useSettingsStore();
  const setupStore = useSetupStore();
  const messagesStore = useMessagesStore();
  const actions = useMessageActions();

  settingsStore.mainApi = {
    ...createDefaultApiConfig(),
    apiurl: 'https://main-delete.example.com/v1/chat/completions',
    key: 'main-delete-key',
    model: 'main-delete-model',
    source: 'openai_compatible',
    saved: true,
  };
  setupStore.selectedPreset = null;

  const existingSnapshot = createArchiveStatData('删除前角色');
  syncStandaloneRuntimeSessionStatData(existingSnapshot, {
    preset: null,
    standaloneLocalContent: settingsStore.standaloneLocalContent,
    sendFullPreset: true,
  });

  const userMessage = messagesStore.appendStandaloneMessage({
    role: 'user',
    raw_content: '测试删除保护',
    content_text: '测试删除保护',
    formatted: '测试删除保护',
    action_options: [],
    stat_data_snapshot: existingSnapshot,
  });
  messagesStore.appendStandaloneMessage({
    role: 'assistant',
    raw_content: createAssistantReply('正式AI正文', '正式AI角色'),
    content_text: '正式AI正文',
    formatted: '正式AI正文',
    action_options: ['1. 正式动作'],
    variable_update_status: 'success',
    stat_data_snapshot: createArchiveStatData('正式AI角色'),
  });

  const formalUserMessage = messagesStore.getMessage(userMessage.message_id);
  assert.ok(formalUserMessage);
  if (formalUserMessage) {
    formalUserMessage.stat_data_snapshot = undefined;
  }

  const deleted = await actions.deleteFromHere(userMessage.message_id, true);
  assert.equal(deleted, false);
  assert.equal(messagesStore.messages.length, 2);
  assert.equal(loadStandaloneStatData().玩家.姓名, '删除前角色');
}

async function testStandaloneMessageActionsClearBusyStateAfterVariableUpdateFailure(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>failure path</Analysis><JSONPatch>[{"op":"replace","path":"/当前位置","value":"失败路径"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>主回复已到达</contenttext><action_options>1. 继续观察</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-variable-failure.example.com/v1/chat/completions',
      key: 'main-variable-failure-key',
      model: 'main-variable-failure-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-variable-failure.example.com/v1/chat/completions',
        key: 'assistant-variable-failure-key',
        model: 'assistant-variable-failure-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    const sent = await actions.sendStandaloneUserMessage('测试变量失败后的收尾', 'variable_update_failure_test');

    assert.equal(sent, true);
    assert.equal(messagesStore.standaloneAssistantGenerationBusy, false);
    assert.equal(messagesStore.hasRunningVariableUpdate, false);
    assert.equal(messagesStore.isStandaloneGenerationLocked, false);

    const lastAssistantMessage = messagesStore.messages
      .filter(message => message.role === 'assistant')
      .slice()
      .reverse()[0];

    assert.ok(lastAssistantMessage);
    assert.equal(lastAssistantMessage?.content_text, '主回复已到达');
    assert.equal(lastAssistantMessage?.variable_update_status, 'failed');
    assert.match(lastAssistantMessage?.variable_update_warning ?? '', /Object target key does not exist|当前位置/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneMessageActionsClearBusyStateWhenSuccessSideEffectThrows(): Promise<void> {
  // 回归测试：主+副 API 都成功、变量更新成功写入消息后，若成功收尾里的副作用（如 refreshData）抛错，
  // 发送按钮仍必须恢复闲置态（busy 标志全部清零）。这是 “显示成功但按钮仍灰” bug 的锁定用例。
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content:
                  '<UpdateVariable><Analysis>ok</Analysis><JSONPatch>[{"op":"replace","path":"/当前位置","value":"成功路径"}]</JSONPatch></UpdateVariable>',
              },
            },
          ],
        },
      });
    }

    return createMockFetchResponse({
      jsonData: {
        choices: [
          {
            message: {
              content: '<contenttext>主回复已到达</contenttext><action_options>1. 继续观察</action_options>',
            },
          },
        ],
      },
    });
  }) as typeof fetch;

  const statDataStore = useStatDataStore();
  const originalRefreshData = statDataStore.refreshData;
  statDataStore.refreshData = (() => {
    throw new Error('injected refreshData failure');
  }) as typeof statDataStore.refreshData;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-side-effect.example.com/v1/chat/completions',
      key: 'main-side-effect-key',
      model: 'main-side-effect-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-side-effect.example.com/v1/chat/completions',
        key: 'assistant-side-effect-key',
        model: 'assistant-side-effect-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    const sent = await actions.sendStandaloneUserMessage('测试成功收尾副作用抛错', 'success_side_effect_test');

    // 即便 refreshData 抛错，发送流程也应完成，且所有忙碌标志清零，按钮恢复。
    assert.equal(sent, true);
    assert.equal(messagesStore.standaloneAssistantGenerationBusy, false);
    assert.equal(messagesStore.standaloneMainGenerationBusy, false);
    assert.equal(messagesStore.hasRunningVariableUpdate, false);
    assert.equal(messagesStore.isStandaloneGenerationLocked, false);

    const lastAssistantMessage = messagesStore.messages
      .filter(message => message.role === 'assistant')
      .slice()
      .reverse()[0];

    assert.ok(lastAssistantMessage);
    // 消息状态应已翻出 running（成功写入发生在副作用抛错之前）。
    assert.notEqual(lastAssistantMessage?.variable_update_status, 'running');
  } finally {
    statDataStore.refreshData = originalRefreshData;
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneMessageActionsClearBusyStateAfterVariableUpdateTimeout(): Promise<void> {
  resetStandaloneTestEnvironment();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));

    if (isStandaloneVariableUpdateRequest(body)) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const reason = signal.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted-by-test')));
          });
        }
      });
    }

    return Promise.resolve(
      createMockFetchResponse({
        jsonData: {
          choices: [
            {
              message: {
                content: '<contenttext>主回复已到达</contenttext><action_options>1. 继续观察</action_options>',
              },
            },
          ],
        },
      }),
    );
  }) as typeof fetch;

  try {
    const settingsStore = useSettingsStore();
    const setupStore = useSetupStore();
    const messagesStore = useMessagesStore();
    const actions = useMessageActions();

    settingsStore.mainApi = {
      ...createDefaultApiConfig(),
      apiurl: 'https://main-variable-timeout.example.com/v1/chat/completions',
      key: 'main-variable-timeout-key',
      model: 'main-variable-timeout-model',
      source: 'openai_compatible',
      saved: true,
    };
    settingsStore.assistantApis = [
      {
        ...createDefaultApiConfig(),
        apiurl: 'https://assistant-variable-timeout.example.com/v1/chat/completions',
        key: 'assistant-variable-timeout-key',
        model: 'assistant-variable-timeout-model',
        source: 'openai_compatible',
        saved: true,
      },
    ];
    setupStore.selectedPreset = null;

    const originalSetTimeout = globalThis.setTimeout;
    const originalWindowSetTimeout = window.setTimeout;
    const fastTimeout = ((handler: TimerHandler, _timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;

    globalThis.setTimeout = fastTimeout;
    window.setTimeout = fastTimeout;

    try {
      const sent = await actions.sendStandaloneUserMessage('测试变量超时后的收尾', 'variable_update_timeout_test');
      assert.equal(sent, true);
      await flushScheduledUiEffects(8);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      window.setTimeout = originalWindowSetTimeout;
    }

    assert.equal(messagesStore.standaloneAssistantGenerationBusy, false);
    assert.equal(messagesStore.hasRunningVariableUpdate, false);
    assert.equal(messagesStore.isStandaloneGenerationLocked, false);

    const lastAssistantMessage = messagesStore.messages
      .filter(message => message.role === 'assistant')
      .slice()
      .reverse()[0];

    assert.ok(lastAssistantMessage);
    assert.equal(lastAssistantMessage?.content_text, '主回复已到达');
    assert.equal(lastAssistantMessage?.variable_update_status, 'failed');
    assert.match(lastAssistantMessage?.variable_update_warning ?? '', /变量更新补写超时/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testStandaloneStatDataFallsBackFromLegacyStorageIntoRuntimeSession(): Promise<void> {
  resetStandaloneTestEnvironment();
  const legacyOnlyStatData = createArchiveStatData('旧存储角色');
  localStorage.setItem('th1980s:standalone-stat-data', JSON.stringify(legacyOnlyStatData));

  const loaded = loadStandaloneStatData();
  const runtimeSession = loadStandaloneRuntimeSession();

  assert.equal(loaded.玩家.姓名, '旧存储角色');
  assert.ok(runtimeSession);
  assert.equal(runtimeSession?.stat_data.玩家.姓名, '旧存储角色');
}

async function testLoadStandaloneMessagesRepairsMissingSnapshotsAndRegeneratesFormattedHtml(): Promise<void> {
  resetStandaloneTestEnvironment();

  const statData = createArchiveStatData('缺快照角色');
  ensureStandaloneRuntimeBootstrap(statData, {
    preset: null,
    standaloneLocalContent: resolveStoredStandaloneLocalContentSettings({
      storedSettings: { enabledAssets: {} },
      imagePromptEnabled: false,
      onlineModeEnabled: false,
    }),
    sendFullPreset: true,
  });

  localStorage.setItem(
    'th1980s:standalone-runtime-messages',
    JSON.stringify({
      session_id: loadStandaloneRuntimeSession()!.id,
      next_message_id: 2,
      records: [
        {
          message_id: 0,
          role: 'user',
          raw_content: '第一条用户消息',
          content_text: '第一条用户消息',
          formatted: '<img src=x onerror=alert(1)>',
          action_options: [],
          createdAt: '2026-04-15T00:00:00.000Z',
        },
        {
          message_id: 1,
          role: 'assistant',
          raw_content: '<contenttext>第二条助手消息</contenttext>',
          content_text: '第二条助手消息',
          formatted: '<script>alert(2)</script>',
          action_options: [],
          createdAt: '2026-04-15T00:00:01.000Z',
        },
      ],
    }),
  );

  const messagesStore = useMessagesStore();
  messagesStore.loadAllMessages();

  assert.equal(messagesStore.messages.length, 2);
  assert.equal(messagesStore.messages[0]?.stat_data_snapshot?.玩家?.姓名, '缺快照角色');
  assert.equal(messagesStore.messages[1]?.stat_data_snapshot?.玩家?.姓名, '缺快照角色');
  assert.doesNotMatch(messagesStore.messages[0]?.formatted ?? '', /onerror|<img/i);
  assert.doesNotMatch(messagesStore.messages[1]?.formatted ?? '', /<script/i);
  assert.match(messagesStore.messages[1]?.formatted ?? '', /第二条助手消息/);
}

function testArchiveSummaryToastFormattingEscapesHtml(): void {
  assert.equal(
    formatArchiveSummaryForToast('<img src=x onerror=alert(1)>&"\''),
    '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;',
  );
}

function testArchiveFeedbackMessageKeySelection(): void {
  assert.equal(
    getStandaloneArchiveFeedbackMessageKey({
      scope: 'setup',
      mode: 'restore',
      outcome: {
        archiveId: 'archive-1',
        resumedImmediately: true,
        requiresSettingsResume: false,
      },
    }),
    'setup.standalone.archiveRestoreResumeNow',
  );
  assert.equal(
    getStandaloneArchiveFeedbackMessageKey({
      scope: 'setup',
      mode: 'import',
      outcome: {
        archiveId: 'archive-2',
        resumedImmediately: false,
        requiresSettingsResume: true,
      },
    }),
    'setup.standalone.archiveImportNeedsSettings',
  );
  assert.equal(
    getStandaloneArchiveFeedbackMessageKey({
      scope: 'contentCenter',
      mode: 'restore',
      outcome: {
        archiveId: 'archive-3',
        resumedImmediately: true,
        requiresSettingsResume: false,
      },
    }),
    'contentCenter.archiveRestoreResumeNow',
  );
  assert.equal(
    getStandaloneArchiveFeedbackMessageKey({
      scope: 'contentCenter',
      mode: 'import',
      outcome: {
        archiveId: 'archive-4',
        resumedImmediately: false,
        requiresSettingsResume: true,
      },
    }),
    'contentCenter.archiveImportNeedsSettings',
  );
}

async function testStandaloneArchiveRoundTripDropsDebugTrace(): Promise<void> {
  const seeded = await seedStandaloneArchiveScenario({
    playerName: '调试归档角色',
    sendFullPreset: true,
    presetName: '调试归档预设',
  });

  const assistantMessage = seeded.messagesStore.messages.find(message => message.role === 'assistant');
  assert.ok(assistantMessage);
  seeded.messagesStore.patchMessageRecord(assistantMessage!.message_id, {
    debug_trace: {
      main_pass: {
        api_label: 'openai_compatible:archive-main-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-04-09T00:00:00.000Z',
        transport_mode: 'non_streaming',
        request_messages: [
          { role: 'system', content: '系统归档调试' },
          { role: 'user', content: '用户归档调试' },
        ],
        request_body_text: '{"model":"archive-main-model"}',
        raw_response_text: '{"choices":[{"message":{"content":"<contenttext>归档前正文</contenttext>"}}]}',
        extracted_text: '<contenttext>归档前正文</contenttext>',
        error_message: null,
      },
      variable_update_pass: {
        api_label: 'openai_compatible:archive-assistant-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-04-09T00:01:00.000Z',
        transport_mode: 'non_streaming',
        request_messages: [{ role: 'user', content: '变量更新归档调试' }],
        request_body_text: '{"model":"archive-assistant-model"}',
        raw_response_text: '{"choices":[{"message":{"content":"<UpdateVariable>[]</UpdateVariable>"}}]}',
        extracted_text: '<UpdateVariable>[]</UpdateVariable>',
        error_message: null,
      },
      assistant_api_pass: {
        api_label: 'openai_compatible:archive-script-assistant-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-04-09T00:02:00.000Z',
        transport_mode: 'streaming',
        request_messages: [
          { role: 'user', content: '[当前变量快照 stat_data]\n{"玩家":{"姓名":"调试归档角色"}}' },
          { role: 'assistant', content: '主回复正文' },
          { role: 'user', content: '[mvu_update] 规则' },
        ],
        request_body_text: '{"model":"archive-script-assistant-model"}',
        raw_response_text:
          '{"choices":[{"message":{"content":"<UpdateVariable>[{\"op\":\"replace\",\"path\":\"/玩家/姓名\",\"value\":\"辅助归档成功\"}]</UpdateVariable>"}}]}',
        extracted_text:
          '<UpdateVariable>[{"op":"replace","path":"/玩家/姓名","value":"辅助归档成功"}]</UpdateVariable>',
        error_message: null,
      },
    },
  });

  const savedEntry = await saveStandaloneArchiveSnapshot();
  seeded.messagesStore.clearMessages();

  await restoreStandaloneArchiveById(savedEntry.id);
  await flushScheduledUiEffects();

  const restoredAssistantMessage = seeded.messagesStore.messages.find(message => message.role === 'assistant');
  // 存档不打包调试记录：正文等内容照常恢复，调试记录应在打包时被剔除
  assert.ok(restoredAssistantMessage);
  assert.ok(restoredAssistantMessage?.content_text);
  assert.equal(restoredAssistantMessage?.debug_trace, undefined);
}

function testMessagesStoreAssistantApiDebugTraceEventBridge(): void {
  resetStandaloneTestEnvironment();
  const messagesStore = useMessagesStore();
  messagesStore.appendStandaloneMessage({
    role: 'assistant',
    raw_content: '<contenttext>测试正文</contenttext>',
    content_text: '测试正文',
    formatted: '测试正文',
    action_options: [],
  });

  messagesStore.setupEventListeners();

  eventEmit('assistant_api_debug_trace_updated', {
    source: 'assistant_api',
    message_id: 0,
    debug_trace: {
      assistant_api_pass: {
        api_label: 'openai_compatible:event-bridge-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-04-12T17:40:00.000Z',
        transport_mode: 'non_streaming',
        request_messages: [{ role: 'user', content: '事件桥测试' }],
        request_body_text: '{"model":"event-bridge-model"}',
        raw_response_text: '<UpdateVariable>[]</UpdateVariable>',
        extracted_text: '<UpdateVariable>[]</UpdateVariable>',
        error_message: null,
      },
    },
  });

  const updatedMessage = messagesStore.getMessage(0);
  assert.equal(updatedMessage?.debug_trace?.assistant_api_pass?.api_label, 'openai_compatible:event-bridge-model');
}

/**
 * 老数据自愈：流式响应的原始抄本（整条 SSE 转录，体积可达正文上百倍）在读到时就该被抹掉，
 * 而非流式的原始响应要保留——否则会把有用的排查信息一起清掉。
 */
function testMessagesStorePrunesLegacyStreamingRawResponseText(): void {
  resetStandaloneTestEnvironment();
  const messagesStore = useMessagesStore();

  messagesStore.appendStandaloneMessage({
    role: 'assistant',
    raw_content: '<contenttext>自愈正文</contenttext>',
    content_text: '自愈正文',
    formatted: '自愈正文',
    action_options: [],
  });

  const legacyStreamTranscript = `${'data: {"choices":[{"delta":{"content":"一"}}]}\n'.repeat(50)}data: [DONE]\n`;
  messagesStore.patchMessageRecord(0, {
    debug_trace: {
      main_pass: {
        api_label: 'openai_compatible:legacy-stream-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-09-01T00:00:00.000Z',
        transport_mode: 'streaming',
        request_messages: [{ role: 'user', content: '老数据' }],
        request_body_text: '{"model":"legacy-stream-model"}',
        raw_response_text: legacyStreamTranscript,
        extracted_text: '自愈正文',
        error_message: null,
      },
      variable_update_pass: {
        api_label: 'openai_compatible:legacy-non-stream-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-09-01T00:01:00.000Z',
        transport_mode: 'non_streaming',
        request_messages: [{ role: 'user', content: '老数据' }],
        request_body_text: '{"model":"legacy-non-stream-model"}',
        raw_response_text: '{"choices":[{"message":{"content":"<UpdateVariable>[]</UpdateVariable>"}}]}',
        extracted_text: '<UpdateVariable>[]</UpdateVariable>',
        error_message: null,
      },
    },
  });

  // 重新加载一次，触发自愈
  messagesStore.loadAllMessages();

  const reloaded = messagesStore.getMessage(0);
  assert.equal(reloaded?.debug_trace?.main_pass?.raw_response_text, '');
  assert.equal(
    reloaded?.debug_trace?.variable_update_pass?.raw_response_text,
    '{"choices":[{"message":{"content":"<UpdateVariable>[]</UpdateVariable>"}}]}',
  );

  // 盘上也要跟着瘦下来，不能只在内存里清
  const persisted = JSON.parse(localStorage.getItem('th1980s:standalone-runtime-messages') ?? '{}') as {
    records?: Array<{ debug_trace?: { main_pass?: { raw_response_text?: string } } }>;
  };
  assert.equal(persisted.records?.[0]?.debug_trace?.main_pass?.raw_response_text, '');
}

async function testAssistantApiMalformedReplyTraceIsDroppedFromArchive(): Promise<void> {
  const seeded = await seedStandaloneArchiveScenario({
    playerName: '坏格式调试角色',
    sendFullPreset: true,
    presetName: '坏格式调试预设',
  });

  const assistantMessage = seeded.messagesStore.messages.find(message => message.role === 'assistant');
  assert.ok(assistantMessage);

  seeded.messagesStore.patchMessageRecord(assistantMessage!.message_id, {
    debug_trace: {
      assistant_api_pass: {
        api_label: 'openai_compatible:malformed-reply-model',
        api_mode: 'openai_compatible',
        requested_at: '2026-04-12T17:41:00.000Z',
        transport_mode: 'streaming',
        request_messages: [{ role: 'user', content: '坏格式回复调试' }],
        request_body_text: '{"model":"malformed-reply-model"}',
        raw_response_text: '<Analysis>坏格式</Analysis>',
        extracted_text: '<Analysis>坏格式</Analysis>',
        error_message: '辅助 API 回复中未找到 <UpdateVariable> 标签内容',
      },
    },
  });

  const savedEntry = await saveStandaloneArchiveSnapshot();
  seeded.messagesStore.clearMessages();

  await restoreStandaloneArchiveById(savedEntry.id);
  await flushScheduledUiEffects();

  const restoredAssistantMessage = seeded.messagesStore.messages.find(message => message.role === 'assistant');
  // 存档不打包调试记录：坏格式回复的排查信息同样不进存档
  assert.ok(restoredAssistantMessage);
  assert.equal(restoredAssistantMessage?.debug_trace, undefined);
}

/**
 * 老存档自愈：历史存档里打包的调试记录在启动时被剔掉，且只跑一次（靠标记跳过）。
 */
async function testStandaloneArchiveDebugTracesArePrunedOnStartup(): Promise<void> {
  resetStandaloneTestEnvironment();
  await seedStandaloneArchiveScenario({
    playerName: '自愈存档角色',
    sendFullPreset: true,
    presetName: '自愈存档预设',
  });

  const savedEntry = await saveStandaloneArchiveSnapshot();
  const storageKey = `th1980s:standalone-archive:${savedEntry.id}`;

  const injectLegacyDebugTrace = () => {
    const payload = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
      floorSnapshots?: Array<Record<string, unknown>>;
    };
    payload.floorSnapshots?.forEach(snapshot => {
      snapshot.debug_trace = {
        main_pass: {
          api_label: 'openai_compatible:legacy-archive-model',
          api_mode: 'openai_compatible',
          requested_at: '2026-09-01T00:00:00.000Z',
          transport_mode: 'streaming',
          request_messages: [{ role: 'user', content: '老存档' }],
          request_body_text: '{"model":"legacy-archive-model"}',
          raw_response_text: 'data: {"choices":[{"delta":{"content":"一"}}]}\n',
          extracted_text: '老存档正文',
          error_message: null,
        },
      };
    });
    localStorage.setItem(storageKey, JSON.stringify(payload));
  };

  injectLegacyDebugTrace();
  await pruneStandaloneArchiveDebugTraces();

  const prunedPayload = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
    floorSnapshots?: Array<{ debug_trace?: unknown }>;
  };
  assert.ok(prunedPayload.floorSnapshots?.length);
  assert.ok(prunedPayload.floorSnapshots?.every(snapshot => !snapshot.debug_trace));

  // 只跑一次：留了标记，之后再塞老数据也不会被处理
  injectLegacyDebugTrace();
  await pruneStandaloneArchiveDebugTraces();
  const untouchedPayload = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
    floorSnapshots?: Array<{ debug_trace?: unknown }>;
  };
  assert.ok(untouchedPayload.floorSnapshots?.some(snapshot => snapshot.debug_trace));
}

/**
 * 导入预设时只留用得上的字段：提示词条目 + 排序表，原始预设里的 extensions 不落盘。
 * 那些扩展字段（正则脚本、内嵌世界书、插件配置）我们一处都没读，单份能占近 1 MB。
 */
async function testImportedTavernPresetDropsUnusedTopLevelFields(): Promise<void> {
  resetStandaloneTestEnvironment();

  const fatDocument = {
    prompts: [{ identifier: 'main', name: '主提示词', enabled: true, role: 'system', content: '正文内容' }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
    extensions: { regex_scripts: [{ scriptName: '大脚本', findRegex: 'x'.repeat(5000) }] },
  } as unknown as StandaloneTavernPresetDocument;

  saveImportedStandaloneTavernPreset({ sourceName: '带扩展字段的预设.json', document: fatDocument });

  const library = loadStandaloneTavernPresetLibrary();
  assert.equal(library.importedPresets.length, 1);
  const savedDocument = library.importedPresets[0].document as Record<string, unknown>;
  assert.deepEqual(Object.keys(savedDocument).sort(), ['prompt_order', 'prompts']);
  assert.equal(savedDocument.extensions, undefined);
  // 提示词内容原样保留
  assert.equal((savedDocument.prompts as Array<{ content: string }>)[0].content, '正文内容');
}

/**
 * 预设库自愈：老数据里整份存盘的预设，启动时被裁掉冗余字段，且只跑一次（靠标记跳过）。
 */
async function testStandaloneTavernPresetLibraryIsSlimmedOnStartup(): Promise<void> {
  resetStandaloneTestEnvironment();

  const legacyLibrary = {
    activePresetId: 'builtin:standalone-main',
    importedPresets: [
      {
        id: 'imported:legacy:1',
        sourceName: '老预设.json',
        importedAt: '2026-09-01T00:00:00.000Z',
        document: {
          prompts: [{ identifier: 'main', name: '主提示词', enabled: true, role: 'system', content: '老正文' }],
          prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
          extensions: { blob: 'z'.repeat(20000) },
        },
      },
    ],
  };
  const storageKey = 'th1980s:standalone-tavern-preset-library';
  localStorage.setItem(storageKey, JSON.stringify(legacyLibrary));

  pruneStandaloneTavernPresetLibraryOversizedFields();

  const slimmed = loadStandaloneTavernPresetLibrary();
  assert.equal(slimmed.importedPresets.length, 1);
  const slimmedDocument = slimmed.importedPresets[0].document as Record<string, unknown>;
  assert.deepEqual(Object.keys(slimmedDocument).sort(), ['prompt_order', 'prompts']);
  assert.equal((slimmedDocument.prompts as Array<{ content: string }>)[0].content, '老正文');

  // 只跑一次：留了标记，之后再塞老数据也不会被处理
  localStorage.setItem(storageKey, JSON.stringify(legacyLibrary));
  pruneStandaloneTavernPresetLibraryOversizedFields();
  const untouched = loadStandaloneTavernPresetLibrary();
  const untouchedDocument = untouched.importedPresets[0].document as Record<string, unknown>;
  assert.ok(untouchedDocument.extensions);
}

/**
 * 单条测试的超时上限。
 *
 * 为什么必须有：有条测试会死等一个永远不来的结果（假请求不理会取消信号）。
 * 没有超时的话，事件循环一空 node 就以「成功」退出，**后面所有测试被静默吞掉、
 * CI 还显示绿**。加上它，挂住的测试会变成一条明确的失败，后面的照跑。
 *
 * 默认 90 秒：产品里有一条 60 秒的「变量更新补写超时」，测试要靠它触发，
 * 上限压太低会把这类测试误判成挂住。可用 STANDALONE_TEST_TIMEOUT_MS 临时覆盖。
 */
const STANDALONE_TEST_TIMEOUT_MS = Number(process.env.STANDALONE_TEST_TIMEOUT_MS) || 90_000;

/**
 * 看门狗必须用「测试跑之前就抓好的」定时器。
 *
 * 有条测试会把 `globalThis.setTimeout` 换成 0ms 版来快进产品的 60 秒超时；
 * 如果看门狗现取 `setTimeout`，就会被它顺手加速成 0ms，秒判「超时」——
 * 变成被测对象把裁判也一起改了。这里在模块加载时就抓死。
 */
const standaloneTestSetTimeout = globalThis.setTimeout;

function withStandaloneTestTimeout(promise: Promise<void>, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = standaloneTestSetTimeout(() => {
      reject(new Error(`测试超时（${STANDALONE_TEST_TIMEOUT_MS}ms 内没有结束）：${label}`));
    }, STANDALONE_TEST_TIMEOUT_MS);

    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type StandaloneTestGlobalSnapshot = {
  fetch: typeof globalThis.fetch;
  setTimeout: typeof globalThis.setTimeout;
  windowSetTimeout: typeof globalThis.setTimeout | undefined;
};

/**
 * 跑挂的测试走不到自己的 `finally`，会把改过的全局（假请求、被压成 0ms 的定时器）
 * 泄漏给后面所有测试，让失败原因没法读。所以每条测试前后都整体还原一次。
 */
function captureStandaloneTestGlobals(): StandaloneTestGlobalSnapshot {
  const windowLike = (globalThis as { window?: { setTimeout?: typeof globalThis.setTimeout } }).window;

  return {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    windowSetTimeout: windowLike?.setTimeout,
  };
}

function restoreStandaloneTestGlobals(snapshot: StandaloneTestGlobalSnapshot): void {
  globalThis.fetch = snapshot.fetch;
  globalThis.setTimeout = snapshot.setTimeout;

  const windowLike = (globalThis as { window?: { setTimeout?: typeof globalThis.setTimeout } }).window;
  if (windowLike && snapshot.windowSetTimeout) {
    windowLike.setTimeout = snapshot.windowSetTimeout;
  }
}

async function run(): Promise<void> {
  const tests = [
    ['passes through plain text', testPassesThroughPlainText],
    ['standalone message formatting supports rich text', testStandaloneMessageFormattingSupportsRichText],
    ['standalone auxiliary formatting supports rich text', testStandaloneAuxiliaryFormattingSupportsRichText],
    ['supports raw interpolation without html escaping', testSupportsRawInterpolationWithoutHtmlEscaping],
    ['supports getvar defaults and lodash random', testSupportsGetvarDefaultsAndLodashRandom],
    ['standalone prompt macro helpers', testStandalonePromptMacroReplacementHelpers],
    ['standalone Tavern variable macro state', testStandaloneTavernMacroState],
    ['tagged reply fallback strips stray contenttext tags', testTaggedReplyFallbackStripsStrayContenttextTags],
    ['prior summaries outside recent window are injected', testPriorSummariesOutsideRecentWindowAreInjected],
    ['stage summary replaces archived prior summaries', testStageSummaryReplacesArchivedPriorSummaries],
    ['stage summary threshold normalization', testStageSummaryThresholdNormalization],
    [
      'collect prior summary items shares window with prompt',
      testCollectStandalonePriorSummaryItemsSharesWindowWithPrompt,
    ],
    ['archive stage summary compresses pending summaries', testArchiveStandaloneStageSummaryCompressesPendingSummaries],
    [
      'assistant api debug trace preferred over legacy variable pass',
      testAssistantApiDebugTracePreferredOverLegacyVariablePass,
    ],
    [
      'registered worldbook registry includes all current entries',
      testRegisteredWorldbookRegistryIncludesAllCurrentEntries,
    ],
    ['preset group helpers split built-in and workshop presets', testPresetGroupHelpersSplitBuiltInAndWorkshopPresets],
    [
      'registered worldbook entries normalize to main worldbook local content',
      testRegisteredWorldbookEntriesNormalizeToMainWorldbookLocalContent,
    ],
    ['built-in preset worldbook auto attach uses registry', testBuiltInPresetWorldbookAutoAttachUsesRegistry],
    [
      'preset rehydrate uses built-in id mapping and preserves existing entries',
      testPresetRehydrateUsesBuiltInIdMappingAndPreservesExistingEntries,
    ],
    [
      'preset rehydrate supports explicit registered worldbook metadata',
      testPresetRehydrateSupportsExplicitRegisteredWorldbookMetadata,
    ],
    [
      'preset rehydrate appends canonical registered entry when same-named non-worldbook exists',
      testPresetRehydrateAppendsCanonicalRegisteredEntryWhenOnlySameNamedNonWorldbookExists,
    ],
    [
      'main pass worldbook prompt from trace prefers actual sent snapshot',
      testResolveMainPassWorldbookPromptFromTracePrefersActualSentSnapshot,
    ],
    ['messages store assistant api debug trace event bridge', testMessagesStoreAssistantApiDebugTraceEventBridge],
    ['renders lottery rules template', testRendersLotteryRulesTemplate],
    ['renders variable update rules template', testRendersVariableUpdateRulesTemplate],
    ['falls back to raw template on render error', testFallsBackToRawTemplateOnRenderError],
    ['resolves preset-aware local content entries', testResolvesPresetAwareLocalContentEntries],
    [
      'opening preset local content does not masquerade as Tavern preset flow',
      testOpeningPresetLocalContentDoesNotMasqueradeAsTavernPresetFlow,
    ],
    [
      'infers formal kinds for legacy and explicit local content entries',
      testInfersFormalKindsForLegacyAndExplicitLocalContentEntries,
    ],
    ['applies variable update mode to standalone local content', testAppliesVariableUpdateModeToStandaloneLocalContent],
    [
      'normalizes stored standalone local content settings from mode',
      testNormalizesStoredStandaloneLocalContentSettingsFromMode,
    ],
    [
      'migrates known legacy worldbook entries from compat assets',
      testMigratesKnownLegacyWorldbookEntriesFromCompatAssets,
    ],
    [
      'warns on unknown legacy worldbook entries without dropping existing content',
      testWarnsOnUnknownLegacyWorldbookEntriesWithoutDroppingExistingContent,
    ],
    [
      'variable update format prompt block stays out of main prompt but present in second pass',
      testVariableUpdateFormatPromptBlockAlwaysPresentInFixedMode,
    ],
    [
      'lottery rule prompt block only appears for scripted lottery turn',
      testLotteryRulePromptBlockOnlyAppearsForScriptedLotteryTurn,
    ],
    [
      'removed variable update thought template stays out of manifest and prompts',
      testRemovedVariableUpdateThoughtTemplateStaysOutOfManifestAndPrompts,
    ],
    [
      'standalone feature local content blocks follow dedicated toggles',
      testStandaloneFeatureLocalContentBlocksFollowDedicatedToggles,
    ],
    ['text to image local content assets switch with backend', testTextToImageLocalContentAssetsSwitchWithBackend],
    ['novelai text to image block follows selected backend', testNovelAiTextToImageBlockFollowsSelectedBackend],
    [
      'stored local content settings honour novelai backend',
      testStoredStandaloneLocalContentSettingsHonourNovelAiBackend,
    ],
    ['builds world difficulty standalone local content', testBuildsWorldDifficultyStandaloneLocalContent],
    ['world difficulty blocks follow selected difficulty', testWorldDifficultyBlocksFollowSelectedDifficulty],
    ['main prompt includes selected world difficulty block', testMainPromptIncludesSelectedWorldDifficultyBlock],
    [
      'main prompt still requires action options without local action option asset',
      testMainPromptStillRequiresActionOptionsWithoutLocalActionOptionAsset,
    ],
    ['main prompt always includes required main reply rule', testMainPromptAlwaysIncludesRequiredMainReplyRule],
    [
      'built-in capua preset carries registered worldbook into main prompt',
      testBuiltInCapuaPresetCarriesRegisteredWorldbookIntoMainPrompt,
    ],
    ['preset loader force reload bypasses resolved cache', testPresetLoaderForceReloadBypassesResolvedCache],
    [
      'standalone runtime session persists formal content context',
      testStandaloneRuntimeSessionPersistsFormalContentContext,
    ],
    ['standalone main api openai request contract', testStandaloneMainApiOpenAiRequestContract],
    ['standalone provider core streaming request contract', testStandaloneProviderCoreStreamingRequestContract],
    ['standalone provider core supports api without key', testStandaloneProviderCoreSupportsApiWithoutKey],
    [
      'standalone provider core falls back when streaming returns whole json',
      testStandaloneProviderCoreFallsBackWhenStreamingReturnsWholeJson,
    ],
    ['standalone openai api url normalization', testStandaloneOpenAiApiUrlNormalization],
    ['standalone main api request normalizes runtime api url', testStandaloneMainApiRequestNormalizesRuntimeApiUrl],
    [
      'openai compatible models use sillytavern backend when available',
      testOpenAiCompatibleModelsUseSillyTavernBackendWhenAvailable,
    ],
    ['openai compatible models fallback to direct fetch', testOpenAiCompatibleModelsFallbackToDirectFetch],
    ['normalize api config forces openai compatible mode', testNormalizeApiConfigForcesOpenAiCompatibleMode],
    ['standalone main api abort contract', testStandaloneMainApiAbortContract],
    ['standalone local turn abort contract', testStandaloneLocalTurnAbortContract],
    ['standalone main api http error includes raw details', testStandaloneMainApiHttpErrorIncludesRawDetails],
    [
      'standalone local turn skips variable update when main api fails',
      testStandaloneLocalTurnSkipsVariableUpdateWhenMainApiFails,
    ],
    [
      'standalone local turn skips variable update when main reply has no content',
      testStandaloneLocalTurnSkipsVariableUpdateWhenMainReplyHasNoContent,
    ],
    [
      'standalone local turn uses assistant api fallback for second pass',
      testStandaloneLocalTurnUsesAssistantApiFallbackForSecondPass,
    ],
    [
      'standalone local turn ignores main api variable update and still uses assistant second pass',
      testStandaloneLocalTurnIgnoresMainApiUpdateVariableAndStillUsesAssistantSecondPass,
    ],
    [
      'standalone local turn exposes main reply before variable update completes',
      testStandaloneLocalTurnExposesMainReplyBeforeVariableUpdateCompletes,
    ],
    [
      'standalone local turn retries variable update when patch apply fails',
      testStandaloneLocalTurnRetriesVariableUpdateWhenPatchApplyFails,
    ],
    [
      'standalone local turn does not retry forever when patch keeps failing',
      testStandaloneLocalTurnDoesNotRetryForeverWhenPatchKeepsFailing,
    ],
    [
      'standalone local turn streams partial main reply before completion',
      testStandaloneLocalTurnStreamsPartialMainReplyBeforeCompletion,
    ],
    [
      'standalone local turn captures debug trace for both passes',
      testStandaloneLocalTurnCapturesDebugTraceForBothPasses,
    ],
    [
      'standalone local turn abort after main reply still rejects finalize',
      testStandaloneLocalTurnAbortAfterMainReplyStillRejectsFinalize,
    ],
    [
      'standalone message actions project streaming preview without mutating stat data',
      testStandaloneMessageActionsProjectStreamingPreviewWithoutMutatingStatData,
    ],
    [
      'standalone local turn marks variable update failure when assistant api is missing',
      testStandaloneLocalTurnMarksSkippedWhenAssistantApiMissing,
    ],
    [
      'manual refresh latest assistant variable update runs second pass',
      testManualRefreshLatestAssistantVariableUpdateRunsSecondPass,
    ],
    [
      'manual refresh latest assistant variable update timeout clears running state',
      testManualRefreshLatestAssistantVariableUpdateTimeoutClearsRunningState,
    ],
    ['standalone resend prefers selected user snapshot', testStandaloneResendPrefersSelectedUserMessageSnapshot],
    [
      'standalone regenerate prefers selected assistant snapshot',
      testStandaloneRegeneratePrefersSelectedAssistantMessageSnapshot,
    ],
    [
      'standalone message actions clear busy state after variable update failure',
      testStandaloneMessageActionsClearBusyStateAfterVariableUpdateFailure,
    ],
    [
      'standalone message actions clear busy state when success side effect throws',
      testStandaloneMessageActionsClearBusyStateWhenSuccessSideEffectThrows,
    ],
    [
      'standalone message actions clear busy state after variable update timeout',
      testStandaloneMessageActionsClearBusyStateAfterVariableUpdateTimeout,
    ],
    [
      'standalone delete blocks formal deletion without snapshot',
      testStandaloneDeleteBlocksFormalDeletionWithoutSnapshot,
    ],
    [
      'standalone stat data falls back from legacy storage into runtime session',
      testStandaloneStatDataFallsBackFromLegacyStorageIntoRuntimeSession,
    ],
    [
      'standalone messages repair missing snapshots and regenerate formatted html',
      testLoadStandaloneMessagesRepairsMissingSnapshotsAndRegeneratesFormattedHtml,
    ],
    ['archive summary toast formatting escapes html', testArchiveSummaryToastFormattingEscapesHtml],
    ['archive feedback message key selection', testArchiveFeedbackMessageKeySelection],
    ['standalone archive round trip drops debug trace', testStandaloneArchiveRoundTripDropsDebugTrace],
    [
      'assistant api malformed reply trace is dropped from archive',
      testAssistantApiMalformedReplyTraceIsDroppedFromArchive,
    ],
    ['messages store prunes legacy streaming raw response text', testMessagesStorePrunesLegacyStreamingRawResponseText],
    ['standalone archive debug traces are pruned on startup', testStandaloneArchiveDebugTracesArePrunedOnStartup],
    ['imported tavern preset drops unused top level fields', testImportedTavernPresetDropsUnusedTopLevelFields],
    ['standalone tavern preset library is slimmed on startup', testStandaloneTavernPresetLibraryIsSlimmedOnStartup],
    [
      'save standalone archive snapshot persists index and payload',
      testSaveStandaloneArchiveSnapshotPersistsIndexAndPayload,
    ],
    ['restore standalone archive restores runtime and stores', testRestoreStandaloneArchiveRestoresRuntimeAndStores],
    [
      'import standalone archive file writes local list and restores state',
      testImportStandaloneArchiveFileWritesListAndRestoresState,
    ],
    ['setup store restore rehydrates stored built-in preset', testSetupStoreRestoreRehydratesStoredBuiltInPreset],
    [
      'setup store import preset rehydrates registered worldbooks',
      testSetupStoreImportPresetRehydratesRegisteredWorldbooks,
    ],
    [
      'setup store ai generated preset rehydrates registered worldbooks',
      testSetupStoreAiGeneratedPresetRehydratesRegisteredWorldbooks,
    ],
    [
      'archive restore rehydrates registered worldbooks for stored preset',
      testArchiveRestoreRehydratesRegisteredWorldbooksForStoredPreset,
    ],
    [
      'restore standalone archive requires api setup before resuming on clean browser',
      testRestoreStandaloneArchiveRequiresApiSetupBeforeResumingOnCleanBrowser,
    ],
    [
      'import standalone archive requires api setup before resuming on clean browser',
      testImportStandaloneArchiveRequiresApiSetupBeforeResumingOnCleanBrowser,
    ],
    ['import standalone archive rejects old archive version', testImportStandaloneArchiveRejectsOldArchiveVersion],
    ['pending archive resume state round trip', testPendingArchiveResumeStateRoundTrip],
  ] as const;

  const filter = process.env.TEST_FILTER?.trim();
  const runnableTests = filter ? tests.filter(([label]) => label.includes(filter)) : tests;

  if (filter && runnableTests.length === 0) {
    throw new Error(`No tests matched TEST_FILTER=${filter}`);
  }

  const passedLabels: string[] = [];
  const failedResults: Array<{ label: string; error: unknown }> = [];

  for (const [label, execute] of runnableTests) {
    const globalsBeforeTest = captureStandaloneTestGlobals();

    try {
      await withStandaloneTestTimeout(
        (async () => {
          await execute();
        })(),
        label,
      );
      passedLabels.push(label);
      console.info(`✔ ${label}`);
    } catch (error) {
      failedResults.push({ label, error });
      console.error(`✖ ${label}`);
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    } finally {
      restoreStandaloneTestGlobals(globalsBeforeTest);
    }
  }

  if (failedResults.length > 0) {
    console.error('');
    console.error(`失败的测试（${failedResults.length} 条）：`);
    failedResults.forEach(({ label }) => console.error(`  ✖ ${label}`));
    process.exitCode = 1;
  }

  console.info(`1980s-NW standalone renderer tests: 通过 ${passedLabels.length} / 共 ${runnableTests.length}`);
}

void run().catch(error => {
  console.error('1980s-NW standalone renderer tests failed.');
  console.error(error);
  process.exitCode = 1;
});
