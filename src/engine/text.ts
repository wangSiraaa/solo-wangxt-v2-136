/// <reference lib="ES2022" />

/**
 * 文本工具：所有偏移均为 UTF-16 code unit 偏移，
 * 与 TypeScript Compiler API 及 Monaco 的位置模型一致。
 */

export interface LineAndChar {
  /** 1-based */
  line: number;
  /** 0-based */
  character: number;
}

export function lineAndCharAt(text: string, offset: number): LineAndChar {
  let line = 1;
  let character = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

/** 截取包含 offset 的一行（不含行尾换行）。 */
export function lineContentAt(text: string, offset: number): string {
  const start = Math.max(text.lastIndexOf('\n', offset - 1) + 1, 0);
  let end = text.indexOf('\n', offset);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

export interface Snippet {
  /** 包含命中位置的一行原文 */
  text: string;
  /** 命中词在该行中的起始列（0-based，UTF-16） */
  startCharacter: number;
  /** 命中词长度 */
  length: number;
}

export function buildSnippet(
  text: string,
  offset: number,
  length: number,
): Snippet {
  const pos = lineAndCharAt(text, offset);
  return {
    text: lineContentAt(text, offset),
    startCharacter: pos.character,
    length,
  };
}

/** 判断 pos 是否在 [start, start+length) 范围内。 */
export function containsOffset(
  start: number,
  length: number,
  pos: number,
): boolean {
  return pos >= start && pos < start + length;
}
