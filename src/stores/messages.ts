import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { Schema } from '../../schema/schema';
import type { StandaloneAssistantDebugTrace } from '../utils/standaloneAiDebug';
import { formatMessageContentForDisplay } from '../utils/messageFormatting';
import {
  commitStandaloneRuntimeStateFromStores,
  ensureStandaloneRuntimeBootstrapFromStores,
  getStandaloneRuntimeInitialStatData,
  loadStandaloneRuntimeMessages,
  patchStandaloneRuntimeSessionContextFromStores,
  syncStandaloneRuntimeSessionStatDataFromStores,
} from '../utils/standaloneRuntime';
import { loadStandaloneStatData } from '../utils/standaloneStatData';
import { preserveFrontendAuthoritativeFields } from '../utils/frontendAuthoritativeState';
import { parseStreamingTaggedAssistantReply, parseTaggedAssistantReply } from '../utils/taggedReply';

/**
 * 前端界面最多显示的消息数量
 * 限制为最近 18 条消息
 */
/**
 * 消息记录类型
 */
export interface MessageGeneratedImage {
  status: 'idle' | 'running' | 'done' | 'error';
  /** 本地 ComfyUI：图片在 ComfyUI 服务上的地址 */
  url?: string;
  filename?: string;
  /**
   * 云端出图：图片存在本机 IndexedDB 里的编号。
   * 旧存档没有这个字段 —— 读取时按「有编号走仓库、无编号走 url」两条路处理。
   */
  imageId?: string;
  prompt: string;
  error?: string;
}

export interface MessageRecord {
  message_id: number;
  role: 'user' | 'assistant';
  raw_content: string; // 原始消息内容
  content_text: string; // 提取/过滤后的内容
  think_content?: string | null; // 思维链内容
  summary_content?: string | null; // 总结内容
  update_content?: string | null; // 变量更新内容
  action_options?: string[];
  formatted: string; // 格式化后的 HTML
  is_streaming?: boolean;
  is_partial?: boolean;
  createdAt?: string;
  stat_data_snapshot?: ReturnType<typeof Schema.parse>;
  variable_update_status?: 'running' | 'success' | 'failed' | 'skipped';
  variable_update_warning?: string | null;
  debug_trace?: StandaloneAssistantDebugTrace;
  generated_images?: MessageGeneratedImage[];
  /**
   * 本次回复实际用到的模型名（服务端响应里回传的那个，不是设置里填的）。
   * 只用于楼层头展示；拿不到或旧存档没有时为 undefined，展示层回退到占位文案。
   */
  model?: string;
}

interface MainReplyStreamingContext {
  userMessageId: number | null;
  targetMessageId: number | null;
  isStreaming: boolean;
  hasFormalMessage: boolean;
}

/**
 * 消息状态管理 Store
 *
 * 职责：
 * 1. 统一管理所有消息记录
 * 2. 同步 standalone runtime 本地消息
 * 3. 提供消息的增删改查方法
 */
export const useMessagesStore = defineStore('messages', () => {
  // ========== 状态 ==========
  const messages = ref<MessageRecord[]>([]);
  const isLoading = ref(false);
  const editingMessageId = ref<number | null>(null);
  const editingDraftContent = ref('');
  const standaloneMainGenerationBusy = ref(false);
  const standaloneAssistantGenerationBusy = ref(false);

  // 主 API 流式投影层（只影响可视层，不污染正式 messages 语义）
  const isStreaming = ref(false);
  const streamingMessageId = ref<number | null>(null);
  const streamingRawContent = ref('');
  const streamingRecord = ref<MessageRecord | null>(null);
  const mainReplyContext = ref<MainReplyStreamingContext>({
    userMessageId: null,
    targetMessageId: null,
    isStreaming: false,
    hasFormalMessage: false,
  });
  let pendingStreamingText = '';
  let streamingFlushTimer: number | null = null;

  // ========== 计算属性 ==========
  const visibleMessages = computed<MessageRecord[]>(() => {
    if (!streamingRecord.value) {
      return dedupeMessageRecords(messages.value);
    }

    const merged = [...messages.value];
    const existingIndex = merged.findIndex(message => message.message_id === streamingRecord.value?.message_id);

    if (existingIndex !== -1) {
      merged[existingIndex] = streamingRecord.value;
      return dedupeMessageRecords(merged);
    }

    merged.push(streamingRecord.value);
    return dedupeMessageRecords(merged);
  });

  const isEmpty = computed(() => visibleMessages.value.length === 0);
  const lastMessageId = computed(() => {
    if (messages.value.length === 0) return -1;
    return Math.max(...messages.value.map(m => m.message_id));
  });
  const hasRunningVariableUpdate = computed(() =>
    messages.value.some(message => message.role === 'assistant' && message.variable_update_status === 'running'),
  );
  const isStandaloneGenerationLocked = computed(
    () =>
      standaloneMainGenerationBusy.value || standaloneAssistantGenerationBusy.value || hasRunningVariableUpdate.value,
  );

  // ========== 工具函数 ==========

  function formatMessageContent(contentText: string, role: 'user' | 'assistant', messageId: number): string {
    return formatMessageContentForDisplay(contentText, role, messageId);
  }

  function normalizeRecordForDisplay(record: MessageRecord): MessageRecord {
    const nextContentText = record.content_text ?? '';
    return {
      ...record,
      formatted: formatMessageContent(nextContentText, record.role, record.message_id),
      variable_update_warning: record.variable_update_warning ?? null,
    };
  }

  /**
   * 抹掉老数据里「流式响应的原始抄本」。
   *
   * 老版本会把整条 SSE 的逐字节转录存进调试记录（一个字要裹 150-200 字节的 JSON 包装），
   * 体积可达正文的上百倍。读到老数据时顺手清掉，紧接着的写回就完成了自愈，
   * 用户不需要做任何操作。
   *
   * 只清流式：非流式的原始响应本来就是一次完整 JSON，不大且排查时有用，保留。
   */
  function pruneOversizedStreamingRawFromTrace(
    trace: StandaloneAssistantDebugTrace | undefined,
  ): StandaloneAssistantDebugTrace | undefined {
    if (!trace) {
      return trace;
    }

    let pruned = false;
    for (const pass of [trace.main_pass, trace.variable_update_pass, trace.assistant_api_pass]) {
      if (pass && pass.transport_mode === 'streaming' && pass.raw_response_text) {
        pass.raw_response_text = '';
        pruned = true;
      }
    }

    if (pruned) {
      console.info('[MessagesStore] 已抹掉老数据里流式响应的原始抄本');
    }

    return trace;
  }

  function loadStandaloneMessages() {
    const { messages: bootstrappedMessages } = ensureStandaloneRuntimeBootstrapFromStores(loadStandaloneStatData());
    const runtimeMessages = loadStandaloneRuntimeMessages() ?? bootstrappedMessages;
    const normalizedRecords: MessageRecord[] = runtimeMessages.records.map(record => ({
      ...(record as MessageRecord),
      action_options: record.action_options ?? [],
      createdAt: record.createdAt ?? new Date().toISOString(),
      stat_data_snapshot:
        typeof record.stat_data_snapshot === 'undefined' ? undefined : Schema.parse(record.stat_data_snapshot),
      debug_trace: pruneOversizedStreamingRawFromTrace((record as MessageRecord).debug_trace),
    }));
    const displayReadyRecords = normalizedRecords.map(normalizeRecordForDisplay);
    messages.value = repairStandaloneSnapshots(dedupeMessageRecords(displayReadyRecords));
    persistStandaloneMessagesState();
    isLoading.value = false;
    console.info(`[MessagesStore] standalone 消息已加载 count=${messages.value.length}`);
  }

  function persistStandaloneMessagesState() {
    const bootstrap = ensureStandaloneRuntimeBootstrapFromStores(loadStandaloneStatData());
    commitStandaloneRuntimeStateFromStores({
      statData: bootstrap.session.stat_data,
      messages: {
        session_id: bootstrap.session.id,
        next_message_id: messages.value.reduce((max, item) => Math.max(max, item.message_id), -1) + 1,
        records: messages.value.map(item => ({
          ...item,
          action_options: item.action_options ?? [],
          stat_data_snapshot: item.stat_data_snapshot ? Schema.parse(item.stat_data_snapshot) : undefined,
          createdAt: item.createdAt ?? new Date().toISOString(),
        })),
      },
    });
  }

  function appendStandaloneMessage(record: Omit<MessageRecord, 'message_id'>): MessageRecord {
    const nextMessageId = messages.value.reduce((max, item) => Math.max(max, item.message_id), -1) + 1;
    const nextRecord = normalizeRecordForDisplay({
      ...record,
      action_options: record.action_options ?? [],
      createdAt: record.createdAt ?? new Date().toISOString(),
      stat_data_snapshot: Schema.parse(record.stat_data_snapshot ?? resolveLatestStandaloneStatSnapshot()),
      message_id: nextMessageId,
    });

    messages.value = dedupeMessageRecords([...messages.value, nextRecord]);
    persistStandaloneMessagesState();
    console.info(`[MessagesStore] standalone 追加本地消息 message_id=${nextMessageId} role=${nextRecord.role}`);
    return nextRecord;
  }

  function dedupeMessageRecords(records: MessageRecord[]): MessageRecord[] {
    const dedupedMap = new Map<number, MessageRecord>();
    records.forEach(record => {
      dedupedMap.set(record.message_id, record);
    });

    const deduped = [...dedupedMap.values()].sort((a, b) => a.message_id - b.message_id);
    if (deduped.length !== records.length) {
      console.warn(
        `[MessagesStore] 检测到重复 message_id，已执行去重 original=${records.length} deduped=${deduped.length}`,
      );
    }

    return deduped;
  }

  function resolveLatestStandaloneStatSnapshot(): ReturnType<typeof Schema.parse> {
    const latestSnapshot = messages.value
      .slice()
      .reverse()
      .find(record => record.stat_data_snapshot)?.stat_data_snapshot;

    if (latestSnapshot) {
      return Schema.parse(latestSnapshot);
    }

    return Schema.parse(loadStandaloneStatData());
  }

  function repairStandaloneSnapshots(records: MessageRecord[]): MessageRecord[] {
    let currentSnapshot = Schema.parse(getStandaloneRuntimeInitialStatData());

    return records.map(record => {
      const snapshot = Schema.parse(record.stat_data_snapshot ?? currentSnapshot);
      currentSnapshot = snapshot;
      return {
        ...record,
        stat_data_snapshot: snapshot,
      };
    });
  }

  function resolveRollbackStandaloneStatData(): ReturnType<typeof Schema.parse> {
    const lastSnapshot = messages.value
      .slice()
      .reverse()
      .find(record => record.stat_data_snapshot)?.stat_data_snapshot;

    if (lastSnapshot) {
      return Schema.parse(lastSnapshot);
    }

    return Schema.parse(getStandaloneRuntimeInitialStatData());
  }

  function syncStandaloneStatSnapshotAfterTimelineChange(reason: string) {
    // 回退到剩余楼层的旧快照时，剧情类字段跟随回退，但前端权威字段（商城刷新/签到/积分）保留
    // 玩家在回退前的最新写入，避免删除/重发/重新生成时把刚点的签到、刷新、加积分静默抹掉。
    const liveStatData = Schema.parse(loadStandaloneStatData());
    const rollbackStatData = resolveRollbackStandaloneStatData();
    const nextStatData = preserveFrontendAuthoritativeFields(rollbackStatData, liveStatData);
    syncStandaloneRuntimeSessionStatDataFromStores(nextStatData);
    console.info(`[MessagesStore] standalone 时间线回退后已恢复本地 stat_data reason=${reason}`);
  }

  function syncStandaloneRuntimeContentContext(reason = 'messages_store_sync') {
    patchStandaloneRuntimeSessionContextFromStores();
    console.info(`[MessagesStore] standalone 内容上下文已同步 reason=${reason}`);
  }

  function resetMainReplyContext(reason = 'manual') {
    const previousContext = mainReplyContext.value;
    mainReplyContext.value = {
      userMessageId: null,
      targetMessageId: null,
      isStreaming: false,
      hasFormalMessage: false,
    };
    streamingMessageId.value = null;
    console.info(
      `[MessagesStore] 已重置主回复上下文 reason=${reason} previous_user_message_id=${previousContext.userMessageId ?? 'none'} previous_target_message_id=${previousContext.targetMessageId ?? 'none'} previous_has_formal=${previousContext.hasFormalMessage}`,
    );
  }

  function lockMainReplyTarget(userMessageId: number, reason = 'message_sent') {
    const targetMessageId = Math.max(0, userMessageId + 1);
    const previousContext = mainReplyContext.value;
    mainReplyContext.value = {
      userMessageId,
      targetMessageId,
      isStreaming: false,
      hasFormalMessage: false,
    };
    streamingMessageId.value = targetMessageId;
    console.info(
      `[MessagesStore] 已锁定主回复目标楼层 reason=${reason} user_message_id=${userMessageId} target_message_id=${targetMessageId} previous_user_message_id=${previousContext.userMessageId ?? 'none'} previous_target_message_id=${previousContext.targetMessageId ?? 'none'}`,
    );
  }

  function getLockedAssistantMessageId(): number | null {
    const targetMessageId = mainReplyContext.value.targetMessageId;
    if (targetMessageId === null) {
      console.warn('[MessagesStore] 当前没有已锁定的主回复目标楼层，跳过流式预览投影');
      return null;
    }

    streamingMessageId.value = targetMessageId;
    return targetMessageId;
  }

  function buildStreamingRecord(
    rawContent: string,
    options: { isPartial?: boolean; isStreaming?: boolean } = {},
  ): MessageRecord | null {
    const { isPartial = false, isStreaming: isStreamingRecord = true } = options;
    const parsedReply = parseStreamingTaggedAssistantReply(rawContent);
    const contentText = parsedReply.contentText.trim() || parsedReply.fallbackContentText.trim();
    const hasDisplayContent = Boolean(
      contentText || parsedReply.thinkContent || parsedReply.summaryContent || parsedReply.updateContent,
    );

    if (!hasDisplayContent) {
      return null;
    }

    const messageId = getLockedAssistantMessageId();
    if (messageId === null) {
      return null;
    }

    return {
      message_id: messageId,
      role: 'assistant',
      raw_content: rawContent,
      content_text: contentText,
      think_content: parsedReply.thinkContent,
      summary_content: parsedReply.summaryContent,
      update_content: parsedReply.updateContent,
      action_options: parsedReply.actionOptions,
      formatted: formatMessageContent(contentText, 'assistant', messageId),
      is_streaming: isStreamingRecord,
      is_partial: isPartial,
      createdAt: new Date().toISOString(),
      stat_data_snapshot: resolveLatestStandaloneStatSnapshot(),
      variable_update_warning: null,
    };
  }

  function clearScheduledStreamingFlush() {
    if (streamingFlushTimer !== null) {
      window.clearTimeout(streamingFlushTimer);
      streamingFlushTimer = null;
    }
    pendingStreamingText = '';
  }

  function flushStreamingProjection(reason = 'scheduled') {
    if (!isStreaming.value || !pendingStreamingText) {
      if (streamingFlushTimer !== null) {
        window.clearTimeout(streamingFlushTimer);
        streamingFlushTimer = null;
      }
      return;
    }

    if (streamingFlushTimer !== null) {
      window.clearTimeout(streamingFlushTimer);
      streamingFlushTimer = null;
    }

    streamingRawContent.value = pendingStreamingText;
    streamingRecord.value = buildStreamingRecord(pendingStreamingText, { isStreaming: true, isPartial: false });
    console.info(`[MessagesStore] 已刷新流式投影 reason=${reason}`);
  }

  function scheduleStreamingProjectionFlush(streamText: string) {
    if (!isStreaming.value) {
      return;
    }

    pendingStreamingText = streamText;
    if (streamingFlushTimer !== null) {
      return;
    }

    streamingFlushTimer = window.setTimeout(() => {
      flushStreamingProjection('scheduled_timer');
    }, 120);
  }

  function clearStreamingState(reason = 'manual', options: { preserveMainReplyContext?: boolean } = {}) {
    const { preserveMainReplyContext = false } = options;
    clearScheduledStreamingFlush();
    isStreaming.value = false;
    streamingRawContent.value = '';
    streamingRecord.value = null;

    if (preserveMainReplyContext) {
      mainReplyContext.value = {
        ...mainReplyContext.value,
        isStreaming: false,
      };
      streamingMessageId.value = mainReplyContext.value.targetMessageId;
    } else {
      resetMainReplyContext(`${reason}:reset_context`);
    }

    console.info(
      `[MessagesStore] 已清理流式投影层 reason=${reason} preserve_main_reply_context=${preserveMainReplyContext}`,
    );
  }

  function isPartialPreviewMessage(message_id: number): boolean {
    const currentStreamingRecord = streamingRecord.value;
    if (!currentStreamingRecord?.is_partial) {
      return false;
    }

    if (currentStreamingRecord.message_id !== message_id) {
      return false;
    }

    return !messages.value.some(message => message.message_id === message_id);
  }

  function clearPartialPreview(reason = 'manual_partial_preview_clear') {
    if (!streamingRecord.value?.is_partial) {
      return;
    }

    clearStreamingState(reason);
  }

  function beginStreamingSession(reason = 'generation_started') {
    clearStreamingState(`${reason}:reset_previous`, { preserveMainReplyContext: true });
    isStreaming.value = true;
    mainReplyContext.value = {
      ...mainReplyContext.value,
      isStreaming: true,
      hasFormalMessage: false,
    };

    if (mainReplyContext.value.targetMessageId === null) {
      streamingMessageId.value = null;
      console.warn(`[MessagesStore] 已进入流式状态但尚未锁定主回复目标楼层 reason=${reason}`);
      return;
    }

    streamingMessageId.value = mainReplyContext.value.targetMessageId;
    console.info(
      `[MessagesStore] 已进入流式状态 reason=${reason} target_message_id=${mainReplyContext.value.targetMessageId}`,
    );
  }

  function updateStandaloneStreamingPreview(rawContent: string, reason = 'streaming_update') {
    if (!mainReplyContext.value.targetMessageId) {
      console.warn(`[MessagesStore] 收到流式正文但未锁定目标楼层 reason=${reason}`);
      return;
    }

    if (!isStreaming.value) {
      beginStreamingSession(`${reason}:auto_begin`);
    }

    scheduleStreamingProjectionFlush(rawContent);
  }

  function keepStreamingPreviewAsPartial(reason = 'generation_stopped') {
    if (!streamingRawContent.value) {
      clearStreamingState(`${reason}:empty_raw_content`);
      return;
    }

    const partialRecord = buildStreamingRecord(streamingRawContent.value, {
      isStreaming: false,
      isPartial: true,
    });

    if (!partialRecord) {
      clearStreamingState(`${reason}:no_display_content`);
      return;
    }

    isStreaming.value = false;
    mainReplyContext.value = {
      ...mainReplyContext.value,
      isStreaming: false,
    };
    streamingRecord.value = partialRecord;
    console.info(`[MessagesStore] 已保留未完成流式预览 reason=${reason} message_id=${partialRecord.message_id}`);
  }

  function settleStreamingWithFormalMessage(message_id: number): boolean {
    const record = messages.value.find(message => message.message_id === message_id);
    if (!record || record.role !== 'assistant') {
      return false;
    }

    const targetMessageId = mainReplyContext.value.targetMessageId;
    if (targetMessageId === null || message_id !== targetMessageId) {
      return false;
    }

    mainReplyContext.value = {
      ...mainReplyContext.value,
      isStreaming: false,
      hasFormalMessage: true,
    };

    clearStreamingState(`formal_message_received:${message_id}`);
    return true;
  }

  // ========== 核心方法 ==========
  function syncVisibleWindow(reason = 'manual') {
    console.info(`[MessagesStore] standalone 重载本地消息窗口 reason=${reason}`);
    loadStandaloneMessages();
  }

  /**
   * 加载历史消息
   */
  function loadAllMessages() {
    loadStandaloneMessages();
  }

  /**
   * 删除消息（仅从本地状态删除，不调用酒馆 API）
   * 用于删除操作发起后的乐观更新；最终仍应调用 syncVisibleWindow 重新按真实聊天记录回补窗口
   */
  function removeMessage(message_id: number) {
    const index = messages.value.findIndex(m => m.message_id === message_id);
    if (index !== -1) {
      messages.value.splice(index, 1);
      if (editingMessageId.value === message_id) {
        editingMessageId.value = null;
        editingDraftContent.value = '';
      }
      console.info(`[MessagesStore] 本地移除消息 ${message_id}`);
      persistStandaloneMessagesState();
      syncStandaloneStatSnapshotAfterTimelineChange(`remove:${message_id}`);
    }
  }

  /**
   * 批量删除消息（仅从本地状态删除）
   * 用于删除操作发起后的乐观更新；最终仍应调用 syncVisibleWindow 重新按真实聊天记录回补窗口
   */
  function removeMessages(message_ids: number[]) {
    messages.value = messages.value.filter(m => !message_ids.includes(m.message_id));
    if (editingMessageId.value !== null && message_ids.includes(editingMessageId.value)) {
      editingMessageId.value = null;
      editingDraftContent.value = '';
    }
    console.info(`[MessagesStore] 本地批量移除消息: ${message_ids.join(', ')}`);
    persistStandaloneMessagesState();
    syncStandaloneStatSnapshotAfterTimelineChange(`remove_many:${message_ids.join(',')}`);
  }

  /**
   * 更新消息内容
   *
   * @param message_id 消息楼层号
   * @param contentText 显示的内容（content_text）
   * @param rawContent 原始内容（raw_content），如果不提供则使用 contentText
   */
  function updateMessage(message_id: number, contentText: string, rawContent?: string) {
    const record = messages.value.find(m => m.message_id === message_id);
    if (record) {
      const nextRawContent = rawContent ?? contentText;
      record.raw_content = nextRawContent;
      record.content_text = contentText;
      if (record.role === 'assistant') {
        const parsedReply = parseTaggedAssistantReply(nextRawContent);
        record.think_content = parsedReply.thinkContent;
        record.summary_content = parsedReply.summaryContent;
        record.update_content = parsedReply.updateContent;
        record.action_options = parsedReply.actionOptions;
      }
      record.stat_data_snapshot = Schema.parse(record.stat_data_snapshot ?? resolveLatestStandaloneStatSnapshot());
      record.formatted = formatMessageContent(contentText, record.role, message_id);
      console.info(`[MessagesStore] 更新消息 ${message_id}`);
      persistStandaloneMessagesState();
    }
  }

  function patchMessageRecord(message_id: number, patch: Partial<MessageRecord>) {
    const index = messages.value.findIndex(message => message.message_id === message_id);
    if (index === -1) {
      return;
    }

    const currentRecord = messages.value[index]!;
    const nextRawContent = patch.raw_content ?? currentRecord.raw_content;
    const nextContentText = patch.content_text ?? currentRecord.content_text;
    const nextSnapshot = Schema.parse(
      patch.stat_data_snapshot ?? currentRecord.stat_data_snapshot ?? resolveLatestStandaloneStatSnapshot(),
    );

    let nextRecord: MessageRecord = normalizeRecordForDisplay({
      ...currentRecord,
      ...patch,
      message_id: currentRecord.message_id,
      role: currentRecord.role,
      raw_content: nextRawContent,
      content_text: nextContentText,
      stat_data_snapshot: nextSnapshot,
      action_options: patch.action_options ?? currentRecord.action_options ?? [],
    });

    if (currentRecord.role === 'assistant') {
      const parsedReply = parseTaggedAssistantReply(nextRawContent);
      nextRecord = normalizeRecordForDisplay({
        ...nextRecord,
        think_content: parsedReply.thinkContent,
        summary_content: parsedReply.summaryContent,
        update_content: parsedReply.updateContent,
        action_options: parsedReply.actionOptions,
      });
    }

    messages.value.splice(index, 1, nextRecord);
    console.info(`[MessagesStore] 局部更新消息 ${message_id}`);
    persistStandaloneMessagesState();
  }

  /**
   * 获取指定消息
   */
  function getMessage(message_id: number): MessageRecord | undefined {
    return messages.value.find(m => m.message_id === message_id);
  }

  /**
   * 清空所有消息
   */
  function clearMessages() {
    messages.value = [];
    editingMessageId.value = null;
    editingDraftContent.value = '';
    clearStreamingState('clear_messages');
    console.info('[MessagesStore] 清空所有消息');
    persistStandaloneMessagesState();
  }

  function setStandaloneMainGenerationBusy(active: boolean) {
    standaloneMainGenerationBusy.value = active;
  }

  function setStandaloneAssistantGenerationBusy(active: boolean) {
    standaloneAssistantGenerationBusy.value = active;
  }

  function clearStandaloneGenerationBusy() {
    standaloneMainGenerationBusy.value = false;
    standaloneAssistantGenerationBusy.value = false;
  }

  // ========== 编辑状态管理 ==========

  function startEditing(message_id: number) {
    editingMessageId.value = message_id;
    const record = getMessage(message_id);
    editingDraftContent.value = record?.content_text ?? '';
  }

  function setEditingDraftContent(content: string) {
    editingDraftContent.value = content;
  }

  function stopEditing() {
    editingMessageId.value = null;
    editingDraftContent.value = '';
  }

  function isEditing(message_id: number): boolean {
    return editingMessageId.value === message_id;
  }

  function setupEventListeners() {
    console.info('[MessagesStore] 注册辅助 API 调试记录监听');

    if (typeof eventOn !== 'function') {
      return;
    }

    eventOn('assistant_api_debug_trace_updated', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const messageId = (payload as { message_id?: unknown }).message_id;
      const debugTrace = (payload as { debug_trace?: StandaloneAssistantDebugTrace }).debug_trace;
      if (typeof messageId !== 'number' || !debugTrace) {
        return;
      }

      patchMessageRecord(messageId, {
        debug_trace: debugTrace,
      });
      console.info(`[MessagesStore] 已同步辅助 API 调试记录 message_id=${messageId}`);
    });
  }

  return {
    // 状态
    messages,
    visibleMessages,
    isLoading,
    editingMessageId,
    editingDraftContent,
    standaloneMainGenerationBusy,
    standaloneAssistantGenerationBusy,
    isStreaming,
    streamingMessageId,
    streamingRawContent,
    streamingRecord,

    // 计算属性
    isEmpty,
    lastMessageId,
    hasRunningVariableUpdate,
    isStandaloneGenerationLocked,

    // 方法
    loadAllMessages,
    syncVisibleWindow,
    removeMessage,
    removeMessages,
    updateMessage,
    patchMessageRecord,
    getMessage,
    clearMessages,
    setStandaloneMainGenerationBusy,
    setStandaloneAssistantGenerationBusy,
    clearStandaloneGenerationBusy,
    appendStandaloneMessage,
    lockMainReplyTarget,
    beginStreamingSession,
    updateStandaloneStreamingPreview,
    flushStreamingProjection,
    keepStreamingPreviewAsPartial,
    settleStreamingWithFormalMessage,
    isPartialPreviewMessage,
    clearPartialPreview,
    syncStandaloneRuntimeContentContext,

    // 编辑状态
    startEditing,
    setEditingDraftContent,
    stopEditing,
    isEditing,

    // 事件
    setupEventListeners,
  };
});
