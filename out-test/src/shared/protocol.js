"use strict";
// Worker <-> 主线程 通信协议与共享类型。
// 引擎本身不触碰 DOM / IndexedDB，可在 Node 自测中复用。
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyEdits = applyEdits;
exports.cyrb53 = cyrb53;
/**
 * 按下标从后向前应用编辑，保留所有未涉及区间（含注释与无关格式）。
 * 编辑区间互相重叠时返回 null，调用方应阻止提交。
 */
function applyEdits(content, edits) {
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    let next = content;
    let prevStart = Infinity;
    for (const e of sorted) {
        if (e.end > next.length || e.start < 0 || e.end < e.start)
            return null;
        if (e.end > prevStart)
            return null; // 与后一个编辑重叠
        next = next.slice(0, e.start) + e.newText + next.slice(e.end);
        prevStart = e.start;
    }
    return next;
}
function cyrb53(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0');
}
