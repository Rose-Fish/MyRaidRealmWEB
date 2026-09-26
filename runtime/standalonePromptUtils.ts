type StandaloneMacroRecord = Record<string, unknown>;

export type StandaloneTavernMacroState = Map<string, string>;

const STANDALONE_PROMPT_MACRO_FALLBACKS = {
  user: '玩家',
  char: '当前角色',
  group: '当前群组',
  scenario: '当前场景',
  personality: '角色性格',
  lastChatMessage: '上一条消息',
} as const;

function readStandaloneMacroRecord(input: unknown): StandaloneMacroRecord | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  return input as StandaloneMacroRecord;
}

function readStandaloneMacroPath(input: unknown, path: readonly string[]): string {
  let cursor: unknown = input;

  for (const segment of path) {
    const record = readStandaloneMacroRecord(cursor);
    if (!record) {
      return '';
    }

    cursor = record[segment];
  }

  return typeof cursor === 'string' ? cursor.trim() : '';
}

export function resolveStandaloneMacroUserName(statData: unknown): string {
  return readStandaloneMacroPath(statData, ['玩家', '姓名']);
}

export function resolveStandaloneMacroScenario(statData: unknown): string {
  return readStandaloneMacroPath(statData, ['世界', '空间定位', '当前位置']);
}

export function applyStandalonePromptMacroReplacements(
  template: string,
  input: {
    statData: unknown;
    userName?: string;
    charName?: string;
  },
): string {
  const resolvedUserName =
    (typeof input.userName === 'string' ? input.userName.trim() : '') ||
    resolveStandaloneMacroUserName(input.statData) ||
    STANDALONE_PROMPT_MACRO_FALLBACKS.user;
  const resolvedCharName =
    (typeof input.charName === 'string' ? input.charName.trim() : '') || STANDALONE_PROMPT_MACRO_FALLBACKS.char;
  const resolvedScenario = resolveStandaloneMacroScenario(input.statData) || STANDALONE_PROMPT_MACRO_FALLBACKS.scenario;

  return template
    .replace(/\{\{\s*user\s*\}\}/gi, resolvedUserName)
    .replace(/\{\{\s*char\s*\}\}/gi, resolvedCharName)
    .replace(/\{\{\s*group\s*\}\}/gi, STANDALONE_PROMPT_MACRO_FALLBACKS.group)
    .replace(/\{\{\s*scenario\s*\}\}/gi, resolvedScenario)
    .replace(/\{\{\s*personality\s*\}\}/gi, STANDALONE_PROMPT_MACRO_FALLBACKS.personality)
    .replace(/\{\{\s*lastChatMessage\s*\}\}/gi, STANDALONE_PROMPT_MACRO_FALLBACKS.lastChatMessage)
    .replace(/\{\{\s*format_message_variable::stat_data\s*\}\}/gi, JSON.stringify(input.statData ?? {}, null, 2));
}

function splitStandaloneTavernMacroArguments(value: string): string[] {
  return value.split('::').map(part => part.trim());
}

function findStandaloneTavernMacroEnd(template: string, startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < template.length - 1; index += 1) {
    const pair = template.slice(index, index + 2);
    if (pair === '{{') {
      depth += 1;
      index += 1;
    } else if (pair === '}}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      index += 1;
    }
  }
  return -1;
}

function resolveStandaloneTavernMacroValue(value: string, state: StandaloneTavernMacroState, depth = 0): string {
  if (depth >= 10 || !value.includes('{{')) {
    return value;
  }

  return applyStandaloneTavernMacroState(value, state, depth + 1);
}

export function createStandaloneTavernMacroState(): StandaloneTavernMacroState {
  return new Map();
}

export function applyStandaloneTavernMacroState(
  template: string,
  state: StandaloneTavernMacroState,
  depth = 0,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < template.length) {
    const startIndex = template.indexOf('{{', cursor);
    if (startIndex === -1) {
      output += template.slice(cursor);
      break;
    }

    output += template.slice(cursor, startIndex);
    const endIndex = findStandaloneTavernMacroEnd(template, startIndex);
    if (endIndex === -1) {
      output += template.slice(startIndex);
      break;
    }

    const body = template.slice(startIndex + 2, endIndex).trim();
    const setMatch = body.match(/^setvar::([\s\S]*)$/i);
    const addMatch = body.match(/^addvar::([\s\S]*)$/i);
    const getMatch = body.match(/^getvar::([^\s][\s\S]*?)$/i);

    if (setMatch || addMatch) {
      const [key, ...valueParts] = splitStandaloneTavernMacroArguments((setMatch ?? addMatch)![1]!);
      if (key) {
        const value = valueParts.join('::').trim();
        state.set(key, addMatch ? `${state.get(key) ?? ''}${value}` : value);
      }
    } else if (getMatch) {
      output += resolveStandaloneTavernMacroValue(state.get(getMatch[1]!.trim()) ?? '', state, depth);
    } else if (!/^trim$/i.test(body) && !/^\/\//.test(body)) {
      output += template.slice(startIndex, endIndex + 2);
    }

    cursor = endIndex + 2;
  }

  return output;
}

export function buildStandaloneCurrentStatDataBlock(statData: unknown): string {
  return `[当前变量快照 stat_data]\n${JSON.stringify(statData ?? {}, null, 2).trim()}`;
}
