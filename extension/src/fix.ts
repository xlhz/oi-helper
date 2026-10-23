import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { confirmPreview, lineDiff } from './preview';

export interface FixChange {
    line: number;
    action: 'replaceLine' | 'insertBefore';
    before: string;
    after: string;
    description: string;
}

export interface FixReport {
    id: 'yesCase' | 'freopen' | 'division';
    title: string;
    changes: FixChange[];
    suggestions: string[];
}

export interface FreopenScan {
    hasIn: boolean;
    inName: string;
    hasOut: boolean;
    outName: string;
}

// 与 core/src/freopen_scan.cpp 的匹配规则保持一致
export function scanFreopen(source: string): FreopenScan {
    const result: FreopenScan = { hasIn: false, inName: '', hasOut: false, outName: '' };
    const re = /freopen\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(stdin|stdout)\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const name = match[1];
        const mode = match[2];
        const stream = match[3];
        if (stream === 'stdin' && mode.startsWith('r') && !result.hasIn) {
            result.hasIn = true;
            result.inName = name;
        } else if (stream === 'stdout' && mode.startsWith('w') && !result.hasOut) {
            result.hasOut = true;
            result.outName = name;
        }
    }
    return result;
}

function stripLineComment(line: string): string {
    let inString = '';
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inString) {
            if (ch === '\\') {
                i += 1;
            } else if (ch === inString) {
                inString = '';
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            inString = ch;
        } else if (ch === '/' && line[i + 1] === '/') {
            return line.slice(0, i);
        }
    }
    return line;
}

// 去掉字符串与字符字面量, 避免把 printf 格式串里的 % 当成取模
function maskLiterals(line: string): string {
    let out = '';
    let inString = '';
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inString) {
            if (ch === '\\') {
                out += '  ';
                i += 1;
            } else if (ch === inString) {
                inString = '';
                out += ch;
            } else {
                out += ' ';
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            inString = ch;
            out += ch;
        } else if (ch === '/' && line[i + 1] === '/') {
            break;
        } else {
            out += ch;
        }
    }
    return out;
}

export function findProblemDir(startFile: string): string | undefined {
    let dir = path.dirname(path.resolve(startFile));
    for (let i = 0; i < 8; i += 1) {
        if (fs.existsSync(path.join(dir, 'problem.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

export function readFreopenConfig(problemDir: string | undefined): { in?: string; out?: string } {
    if (!problemDir) {
        return {};
    }
    try {
        const data = JSON.parse(fs.readFileSync(path.join(problemDir, 'problem.json'), 'utf8')) as Record<string, unknown>;
        const fr = (data.freopen && typeof data.freopen === 'object' ? data.freopen : {}) as Record<string, unknown>;
        const inName = String(fr.in ?? data.freopenIn ?? '');
        const outName = String(fr.out ?? data.freopenOut ?? '');
        return { in: inName || undefined, out: outName || undefined };
    } catch {
        return {};
    }
}

// 从题目目录的测试点输出中取参照文本, 用于判定 YES/Yes
export function collectExpectedText(srcFile: string): string {
    const problemDir = findProblemDir(srcFile);
    const dir = problemDir || path.dirname(srcFile);
    const files: string[] = [];
    if (problemDir) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(problemDir, 'problem.json'), 'utf8')) as { tests?: Array<{ out?: string }> };
            for (const test of data.tests || []) {
                if (test.out) {
                    files.push(path.resolve(problemDir, test.out));
                }
            }
        } catch {
            // problem.json 不可读时退回同目录输出文件
        }
    }
    try {
        for (const name of fs.readdirSync(dir)) {
            if (/\.(out|ans)$/i.test(name)) {
                files.push(path.join(dir, name));
            }
        }
    } catch {
        // 目录不可读时只用已收集的文件
    }
    const parts: string[] = [];
    for (const file of files.slice(0, 5)) {
        try {
            if (fs.statSync(file).size <= 262144) {
                parts.push(fs.readFileSync(file, 'utf8'));
            }
        } catch {
            // 单个输出文件不可读时跳过
        }
    }
    return parts.join('\n');
}

export function analyzeYesCase(source: string, expectedText = ''): FixReport {
    const lines = source.split(/\r?\n/);
    const counts: Record<'YES' | 'Yes', number> = { YES: 0, Yes: 0 };
    const hits: Array<{ line: number; variants: string[] }> = [];
    lines.forEach((raw, index) => {
        const code = stripLineComment(raw);
        const variants: string[] = [];
        const re = /"(YES|Yes)"/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(code)) !== null) {
            const value = match[1] as 'YES' | 'Yes';
            counts[value] += 1;
            variants.push(value);
        }
        if (variants.length > 0) {
            hits.push({ line: index + 1, variants });
        }
    });

    const expectedCounts = {
        YES: (expectedText.match(/\bYES\b/g) || []).length,
        Yes: (expectedText.match(/\bYes\b/g) || []).length
    };
    let target: '' | 'YES' | 'Yes' = '';
    if (expectedCounts.YES > expectedCounts.Yes) {
        target = 'YES';
    } else if (expectedCounts.Yes > expectedCounts.YES) {
        target = 'Yes';
    } else if (counts.YES > counts.Yes) {
        target = 'YES';
    } else if (counts.Yes > counts.YES) {
        target = 'Yes';
    }

    const suggestions: string[] = [];
    const changes: FixChange[] = [];
    if (!target) {
        if (counts.YES + counts.Yes > 0) {
            suggestions.push('代码中 YES 与 Yes 数量相同, 题目输出里也没有参照, 请对照题面确认后手动统一.');
        } else {
            suggestions.push('未找到 "YES"/"Yes" 字符串输出, 无需修复.');
        }
        return { id: 'yesCase', title: 'YES/Yes 大小写', changes, suggestions };
    }
    if (expectedCounts.YES + expectedCounts.Yes === 0) {
        suggestions.push(`题目输出中没有可参照的答案, 已按代码中的多数写法判定为 ${target}, 应用前请再核对题面.`);
    }
    for (const hit of hits) {
        const wrong = hit.variants.filter((value) => value !== target);
        if (wrong.length === 0) {
            continue;
        }
        const before = lines[hit.line - 1];
        const after = before.replace(/"Yes"/g, `"${target}"`).replace(/"YES"/g, `"${target}"`);
        if (after !== before) {
            changes.push({
                line: hit.line,
                action: 'replaceLine',
                before,
                after,
                description: `第 ${hit.line} 行: ${Array.from(new Set(wrong)).join('/')} -> ${target}`
            });
        }
    }
    if (changes.length === 0) {
        suggestions.push(`代码输出已统一为 ${target}, 无需修改.`);
    }
    return { id: 'yesCase', title: 'YES/Yes 大小写', changes, suggestions };
}

// 在 main 的 { 之后插入, 返回 1 基的行号
function findMainInsertLine(lines: string[]): { line: number; indent: string } | undefined {
    for (let i = 0; i < lines.length; i += 1) {
        const code = stripLineComment(lines[i]);
        const match = /\b(?:int|signed|auto)\s+main\s*\([^)]*\)\s*(\{)?/.exec(code);
        if (!match) {
            continue;
        }
        const baseIndent = /^\s*/.exec(lines[i])?.[0] || '';
        if (match[1]) {
            return { line: i + 2, indent: `${baseIndent}    ` };
        }
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
            if (stripLineComment(lines[j]).trim() === '{') {
                return { line: j + 2, indent: `${/^\s*/.exec(lines[j])?.[0] || ''}    ` };
            }
        }
    }
    return undefined;
}

function includeInsertLine(lines: string[]): number {
    let last = -1;
    lines.forEach((line, index) => {
        if (/^\s*#\s*include\b/.test(line)) {
            last = index;
        }
    });
    return last >= 0 ? last + 2 : 1;
}

export function analyzeFreopen(source: string, srcFile: string, problemDir?: string): FixReport {
    const lines = source.split(/\r?\n/);
    const scan = scanFreopen(source);
    const dir = problemDir || findProblemDir(srcFile);
    const config = readFreopenConfig(dir);
    const suggestions: string[] = [];
    const changes: FixChange[] = [];
    const missing: string[] = [];

    if (!scan.hasIn) {
        if (config.in) {
            missing.push(`freopen("${config.in}", "r", stdin);`);
        } else {
            suggestions.push('缺少输入重定向, 但题目配置里没有 freopen.in, 请先补充 problem.json 的 freopen 字段.');
        }
    }
    if (!scan.hasOut) {
        if (config.out) {
            missing.push(`freopen("${config.out}", "w", stdout);`);
        } else {
            suggestions.push('缺少输出重定向, 但题目配置里没有 freopen.out, 请先补充 problem.json 的 freopen 字段.');
        }
    }
    if (missing.length === 0) {
        if (scan.hasIn && scan.hasOut) {
            suggestions.push(`代码已有 freopen ("${scan.inName}" / "${scan.outName}"), 无需修复.`);
        }
        return { id: 'freopen', title: '缺少 freopen', changes, suggestions };
    }

    const main = findMainInsertLine(lines);
    if (!main) {
        suggestions.push('未找到 main 函数定义, 无法确定插入位置, 请手动在 main 开头添加 freopen.');
        return { id: 'freopen', title: '缺少 freopen', changes, suggestions };
    }
    const hasCstdio = /#\s*include\s*[<"](?:cstdio|stdio\.h|bits\/stdc\+\+\.h)[>"]/.test(source);
    if (!hasCstdio) {
        changes.push({
            line: includeInsertLine(lines),
            action: 'insertBefore',
            before: '',
            after: '#include <cstdio>',
            description: '补充 #include <cstdio>'
        });
    }
    const body = missing.map((call) => `${main.indent}${call}`).join('\n');
    changes.push({
        line: main.line,
        action: 'insertBefore',
        before: '',
        after: body,
        description: `在 main 开头插入 ${missing.length} 行 freopen`
    });
    if (dir) {
        suggestions.push(`路径取自 ${path.join(dir, 'problem.json')}.`);
    }
    return { id: 'freopen', title: '缺少 freopen', changes, suggestions };
}

export function analyzeDivision(source: string): FixReport {
    const lines = source.split(/\r?\n/);
    const assignedZero = new Set<string>();
    const declaredUninitialized = new Set<string>();
    const declaration = /\b(?:int|long|short|unsigned|signed|size_t|int64_t|long long|ll)\s+(?:[A-Za-z_]\w*\s*,\s*)*([A-Za-z_]\w*)\s*;/g;
    const assignment = /\b([A-Za-z_]\w*)\s*=\s*0\s*;/g;

    for (const raw of lines) {
        const code = stripLineComment(raw);
        let match: RegExpExecArray | null;
        assignment.lastIndex = 0;
        while ((match = assignment.exec(code)) !== null) {
            assignedZero.add(match[1]);
        }
        declaration.lastIndex = 0;
        while ((match = declaration.exec(code)) !== null) {
            declaredUninitialized.add(match[1]);
        }
    }

    const changes: FixChange[] = [];
    const suggestions: string[] = [];
    const guarded = new Set<string>();
    const operand = /([A-Za-z_]\w*|\d+|\)|\])\s*([/%])\s*([A-Za-z_]\w*|\d+)/g;

    lines.forEach((raw, index) => {
        if (/^\s*#/.test(raw)) {
            return;
        }
        const code = maskLiterals(raw);
        operand.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = operand.exec(code)) !== null) {
            const op = match[2];
            const right = match[3];
            if (/^\d+$/.test(right)) {
                if (Number(right) === 0) {
                    suggestions.push(`第 ${index + 1} 行存在常量 0 作为 ${op} 的右操作数, 补判断无法修复常量除零, 请检查表达式.`);
                }
                continue;
            }
            if (!assignedZero.has(right) && !declaredUninitialized.has(right)) {
                suggestions.push(`第 ${index + 1} 行 ${op} 的右操作数 ${right} 无法确认非 0, 如需保护请手动补判断.`);
                continue;
            }
            const key = `${index}:${right}`;
            if (guarded.has(key)) {
                continue;
            }
            guarded.add(key);
            const indent = /^\s*/.exec(raw)?.[0] || '';
            changes.push({
                line: index + 1,
                action: 'insertBefore',
                before: '',
                after: [
                    `${indent}if (${right} == 0) {`,
                    `${indent}    return 0; // TODO: ${right} 为 0 时按题意处理`,
                    `${indent}}`
                ].join('\n'),
                description: `第 ${index + 1} 行 ${op} 的右操作数 ${right} 可能为 0, 补判断分支`
            });
        }
    });

    if (changes.length === 0 && suggestions.length === 0) {
        suggestions.push('未发现除号或取模右操作数可能为 0 的位置.');
    }
    return { id: 'division', title: '除零/模零', changes, suggestions };
}

export function applyFixChanges(source: string, changes: FixChange[]): string {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    const sorted = changes.slice().sort((a, b) => {
        if (a.line !== b.line) {
            return b.line - a.line;
        }
        if (a.action === b.action) {
            return 0;
        }
        return a.action === 'replaceLine' ? -1 : 1;
    });
    for (const change of sorted) {
        const index = change.line - 1;
        if (index < 0 || index > lines.length) {
            continue;
        }
        if (change.action === 'insertBefore') {
            lines.splice(index, 0, ...change.after.split('\n'));
        } else if (index < lines.length) {
            lines[index] = change.after;
        }
    }
    return lines.join(eol);
}

function activeEditor(): vscode.TextEditor {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('请先打开要修复的 C++ 源文件.');
    }
    return editor;
}

async function applyReport(
    output: vscode.OutputChannel,
    editor: vscode.TextEditor,
    report: FixReport
): Promise<void> {
    const source = editor.document.getText();
    const next = applyFixChanges(source, report.changes);
    const ok = await confirmPreview(
        output,
        `${report.title}: 将修改 ${report.changes.length} 处, 是否继续?`,
        lineDiff(source, next),
        report.suggestions.join('\n')
    );
    if (!ok) {
        vscode.window.showInformationMessage('已取消, 未修改代码.');
        return;
    }
    const range = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(source.length));
    const applied = await editor.edit((builder) => builder.replace(range, next));
    if (!applied) {
        throw new Error('写入失败, 编辑器拒绝了修改.');
    }
    vscode.window.showInformationMessage(`${report.title}: 已修改 ${report.changes.length} 处.`);
}

function reportSuggestions(output: vscode.OutputChannel, report: FixReport): void {
    for (const suggestion of report.suggestions) {
        output.appendLine(`[修复建议] ${suggestion}`);
    }
    output.show(true);
    vscode.window.showInformationMessage(report.suggestions.join(' ') || '未发现需要修复的位置.');
}

export async function fixYesCaseCommand(output: vscode.OutputChannel): Promise<void> {
    const editor = activeEditor();
    const source = editor.document.getText();
    const report = analyzeYesCase(source, collectExpectedText(editor.document.fileName));
    if (report.changes.length === 0) {
        reportSuggestions(output, report);
        return;
    }
    await applyReport(output, editor, report);
}

export async function fixFreopenCommand(output: vscode.OutputChannel): Promise<void> {
    const editor = activeEditor();
    const source = editor.document.getText();
    const report = analyzeFreopen(source, editor.document.fileName);
    if (report.changes.length === 0) {
        reportSuggestions(output, report);
        return;
    }
    await applyReport(output, editor, report);
}

export async function fixDivisionCommand(output: vscode.OutputChannel): Promise<void> {
    const editor = activeEditor();
    const source = editor.document.getText();
    const report = analyzeDivision(source);
    if (report.changes.length === 0) {
        reportSuggestions(output, report);
        return;
    }
    await applyReport(output, editor, report);
}
