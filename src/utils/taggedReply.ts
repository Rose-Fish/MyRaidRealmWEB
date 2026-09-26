export interface ParsedTaggedAssistantReply {
  rawContent: string;
  contentText: string;
  /** 已移除已知辅助标签后的正文兜底文本 */
  fallbackContentText: string;
  thinkContent: string | null;
  summaryContent: string | null;
  updateContent: string | null;
  updateAnalysis: string | null;
  updateJsonPatchText: string | null;
  actionOptions: string[];
}

export interface TaggedUpdateDetails {
  updateAnalysis: string | null;
  updateJsonPatchText: string | null;
}

const UPDATE_VARIABLE_BLOCK_REGEX = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i;
const CONTENT_TEXT_REGEX = /<contenttext\b[^>]*>([\s\S]*?)<\/contenttext>/i;
const ACTION_OPTIONS_REGEX = /<action_options\b[^>]*>([\s\S]*?)<\/action_options>/i;

function extractTagContents(text: string, regex: RegExp): { content: string | null; cleaned: string } {
  const contents: string[] = [];
  const cleaned = text.replace(regex, (_, inner: string) => {
    const trimmed = inner?.trim();
    if (trimmed) {
      contents.push(trimmed);
    }
    return '';
  });

  return {
    content: contents.length > 0 ? contents.join('\n\n') : null,
    cleaned,
  };
}

export function extractTaggedContentText(message: string): string {
  const match = message.match(CONTENT_TEXT_REGEX);
  return match?.[1]?.trim() ?? '';
}

export function extractTaggedActionOptions(message: string): string[] {
  const match = message.match(ACTION_OPTIONS_REGEX);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function parseUpdateVariableDetails(updateContent: string | null): TaggedUpdateDetails {
  if (!updateContent) {
    return {
      updateAnalysis: null,
      updateJsonPatchText: null,
    };
  }

  const analysisMatch = updateContent.match(/<Analysis>([\s\S]*?)<\/Analysis>/i);
  const jsonPatchMatch = updateContent.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i);

  return {
    updateAnalysis: analysisMatch?.[1]?.trim() ?? null,
    updateJsonPatchText: jsonPatchMatch?.[1]?.trim() ?? null,
  };
}

export function parseTaggedAssistantReply(rawContent: string): ParsedTaggedAssistantReply {
  let working = rawContent;

  const thinkingTags = extractTagContents(working, /<analysis_block>([\s\S]*?)<\/analysis_block>/gi);
  working = thinkingTags.cleaned;

  const summaryTags = extractTagContents(working, /<summary>([\s\S]*?)<\/summary>/gi);
  working = summaryTags.cleaned;

  const updateTags = extractTagContents(working, /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi);
  working = updateTags.cleaned;

  const actionOptionsTags = extractTagContents(working, /<action_options\b[^>]*>([\s\S]*?)<\/action_options>/gi);
  working = actionOptionsTags.cleaned;
  const { updateAnalysis, updateJsonPatchText } = parseUpdateVariableDetails(updateTags.content);

  return {
    rawContent,
    contentText: extractTaggedContentText(rawContent),
    fallbackContentText: working.trim(),
    thinkContent: thinkingTags.content,
    summaryContent: summaryTags.content,
    updateContent: updateTags.content,
    updateAnalysis,
    updateJsonPatchText,
    actionOptions: extractTaggedActionOptions(rawContent),
  };
}

export function hasUpdateVariableBlock(rawContent: string): boolean {
  return UPDATE_VARIABLE_BLOCK_REGEX.test(rawContent);
}

export function replaceOrAppendUpdateVariableBlock(rawContent: string, updateBlock: string): string {
  if (hasUpdateVariableBlock(rawContent)) {
    return rawContent.replace(UPDATE_VARIABLE_BLOCK_REGEX, updateBlock.trim());
  }

  const normalizedRawContent = rawContent.trimEnd();
  const normalizedUpdateBlock = updateBlock.trim();
  return normalizedRawContent ? `${normalizedRawContent}\n\n${normalizedUpdateBlock}` : normalizedUpdateBlock;
}

export function extractStreamingTaggedSection(message: string, tagName: string): string | null {
  const contents: string[] = [];
  const fullTagRegex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'gi');

  message.replace(fullTagRegex, (_, inner: string) => {
    const trimmed = inner?.trim();
    if (trimmed) {
      contents.push(trimmed);
    }
    return '';
  });

  const lowerMessage = message.toLowerCase();
  const openTag = `<${tagName.toLowerCase()}>`;
  const closeTag = `</${tagName.toLowerCase()}>`;
  const lastOpenIndex = lowerMessage.lastIndexOf(openTag);
  const lastCloseIndex = lowerMessage.lastIndexOf(closeTag);

  if (lastOpenIndex !== -1 && lastOpenIndex > lastCloseIndex) {
    const partialContent = message.slice(lastOpenIndex + openTag.length).trim();
    if (partialContent) {
      contents.push(partialContent);
    }
  }

  return contents.length > 0 ? contents.join('\n\n') : null;
}

export function parseStreamingTaggedAssistantReply(message: string): ParsedTaggedAssistantReply {
  const parsedComplete = parseTaggedAssistantReply(message);

  return {
    ...parsedComplete,
    contentText: extractStreamingTaggedSection(message, 'contenttext') ?? '',
    thinkContent: extractStreamingTaggedSection(message, 'analysis_block'),
    summaryContent: extractStreamingTaggedSection(message, 'summary'),
    updateContent: extractStreamingTaggedSection(message, 'UpdateVariable'),
    ...parseUpdateVariableDetails(extractStreamingTaggedSection(message, 'UpdateVariable')),
    actionOptions: extractTaggedActionOptions(message),
  };
}
