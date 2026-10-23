import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findExecutable, queryIncludePaths } from './envCheck';
import { confirmPreview, lineDiff } from './preview';

const CONFIG_NAME = 'OIHelper';
const TASK_LABEL = 'OIHelper: 编译';
const LAUNCH_NAME = 'OIHelper: 调试';

export interface WorkspaceConfigOptions {
    compilerPath?: string;
    includePaths: string[];
    standard: string;
}

export interface ConfigPlanItem {
    name: string;
    filePath: string;
    existed: boolean;
    changed: boolean;
    before: string;
    after: string;
    preview: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 容忍注释与尾逗号的 JSON 解析; 失败返回 undefined
export function parseJsonc(text: string): unknown {
    const source = text.replace(/^\uFEFF/, '');
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];
        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                out += ch;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (inString) {
            out += ch;
            if (ch === '\\') {
                out += next ?? '';
                i += 1;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '/' && next === '/') {
            inLineComment = true;
            i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
        }
        out += ch;
    }
    try {
        return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
    } catch {
        return undefined;
    }
}

function buildTemplates(options: WorkspaceConfigOptions): Record<string, JsonObject> {
    const compiler = options.compilerPath || 'g++';
    const gdbCandidate = options.compilerPath
        ? path.join(path.dirname(options.compilerPath), process.platform === 'win32' ? 'gdb.exe' : 'gdb')
        : '';
    const gdb = gdbCandidate && fs.existsSync(gdbCandidate) ? gdbCandidate : 'gdb';
    const includePath = ['${workspaceFolder}/**', ...options.includePaths.filter((p) => p.length > 0)];
    const uniqueIncludes = includePath.filter((value, index) => includePath.indexOf(value) === index);

    const cppProperties: JsonObject = {
        configurations: [
            {
                name: CONFIG_NAME,
                includePath: uniqueIncludes,
                defines: [],
                compilerPath: compiler,
                cStandard: 'c17',
                cppStandard: options.standard,
                intelliSenseMode: process.platform === 'win32' ? 'windows-gcc-x64' : 'gcc-x64'
            }
        ],
        version: 4
    };

    const tasks: JsonObject = {
        version: '2.0.0',
        tasks: [
            {
                label: TASK_LABEL,
                type: 'shell',
                command: compiler,
                args: [
                    `-std=${options.standard}`,
                    '-O2',
                    '-Wall',
                    '-Wextra',
                    '-o',
                    process.platform === 'win32'
                        ? '${fileDirname}\\${fileBasenameNoExtension}.exe'
                        : '${fileDirname}/${fileBasenameNoExtension}',
                    '${file}'
                ],
                group: { kind: 'build', isDefault: true },
                problemMatcher: ['$gcc'],
                options: { cwd: '${fileDirname}' }
            }
        ]
    };

    const launch: JsonObject = {
        version: '0.2.0',
        configurations: [
            {
                name: LAUNCH_NAME,
                type: 'cppdbg',
                request: 'launch',
                program: process.platform === 'win32'
                    ? '${fileDirname}\\${fileBasenameNoExtension}.exe'
                    : '${fileDirname}/${fileBasenameNoExtension}',
                args: [],
                stopAtEntry: false,
                cwd: '${fileDirname}',
                environment: [],
                externalConsole: true,
                MIMode: 'gdb',
                miDebuggerPath: gdb,
                setupCommands: [
                    { description: '为 gdb 启用整齐打印', text: '-enable-pretty-printing', ignoreFailures: true }
                ],
                preLaunchTask: TASK_LABEL
            }
        ]
    };

    const settings: JsonObject = {
        'files.encoding': 'utf8',
        'files.autoGuessEncoding': true,
        'editor.tabSize': 4,
        'C_Cpp.default.cppStandard': options.standard,
        'oiHelper.standard': options.standard
    };

    return {
        'c_cpp_properties.json': cppProperties,
        'tasks.json': tasks,
        'launch.json': launch,
        'settings.json': settings
    };
}

function mergeConfig(name: string, existing: JsonObject, generated: JsonObject): JsonObject {
    if (name === 'settings.json') {
        return { ...existing, ...generated };
    }
    const key = name === 'tasks.json' ? 'tasks' : 'configurations';
    const existingList = Array.isArray(existing[key]) ? existing[key] as JsonObject[] : [];
    const generatedList = Array.isArray(generated[key]) ? generated[key] as JsonObject[] : [];
    const matchKey = name === 'tasks.json' ? 'label' : 'name';
    const matchValue = name === 'c_cpp_properties.json' ? CONFIG_NAME : name === 'tasks.json' ? TASK_LABEL : LAUNCH_NAME;
    const index = existingList.findIndex((item) => isObject(item) && item[matchKey] === matchValue);
    const merged = existingList.slice();
    if (index >= 0) {
        merged[index] = generatedList[0];
    } else {
        merged.push(...generatedList);
    }
    const result: JsonObject = { ...existing };
    result[key] = merged;
    if (name === 'c_cpp_properties.json') {
        result.version = 4;
    } else if (name === 'tasks.json') {
        result.version = '2.0.0';
    } else {
        result.version = '0.2.0';
    }
    return result;
}

function pretty(value: unknown): string {
    return `${JSON.stringify(value, null, 4)}\n`;
}

export function planWorkspaceConfig(targetDir: string, options: WorkspaceConfigOptions): ConfigPlanItem[] {
    const generated = buildTemplates(options);
    const vscodeDir = path.join(targetDir, '.vscode');
    return Object.keys(generated).map((name) => {
        const filePath = path.join(vscodeDir, name);
        const existed = fs.existsSync(filePath);
        const before = existed ? fs.readFileSync(filePath, 'utf8') : '';
        let after: string;
        let note = '';
        if (!existed) {
            after = pretty(generated[name]);
        } else {
            const parsed = parseJsonc(before);
            if (isObject(parsed)) {
                after = pretty(mergeConfig(name, parsed, generated[name]));
            } else {
                after = pretty(generated[name]);
                note = '原文件无法解析为 JSON, 将整体替换.';
            }
        }
        const changed = before !== after;
        const preview = existed
            ? `${note ? `${note}\n` : ''}${lineDiff(before, after)}`
            : after;
        return { name, filePath, existed, changed, before, after, preview };
    });
}

export function writeConfigPlan(items: ConfigPlanItem[]): string[] {
    const written: string[] = [];
    for (const item of items) {
        if (!item.changed) {
            continue;
        }
        fs.mkdirSync(path.dirname(item.filePath), { recursive: true });
        fs.writeFileSync(item.filePath, item.after, 'utf8');
        written.push(item.name);
    }
    return written;
}

export async function applyEditorConfigCommand(output: vscode.OutputChannel): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('未打开工作区, 无法生成编辑器配置.');
    }
    let target = folders[0].uri.fsPath;
    if (folders.length > 1) {
        const picked = await vscode.window.showQuickPick(
            folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
            { placeHolder: '选择要生成配置的工作区' }
        );
        if (!picked) {
            return;
        }
        target = picked.folder.uri.fsPath;
    }
    const standard = vscode.workspace.getConfiguration('oiHelper').get<string>('standard', 'c++14');
    const compiler = findExecutable('g++');
    const includes = compiler ? queryIncludePaths(compiler) : [];
    if (!compiler) {
        output.appendLine('[配置] 未找到 g++, 编译器路径写为 g++, 请安装后重新生成.');
    }
    const plan = planWorkspaceConfig(target, { compilerPath: compiler, includePaths: includes, standard });
    const changed = plan.filter((item) => item.changed);
    if (changed.length === 0) {
        vscode.window.showInformationMessage('编辑器配置已是最新, 未写入任何文件.');
        return;
    }
    const existing = changed.filter((item) => item.existed);
    if (existing.length > 0) {
        const preview = existing
            .map((item) => `== ${item.name} ==\n${item.preview}`)
            .join('\n\n');
        const ok = await confirmPreview(
            output,
            `将修改 ${existing.map((item) => item.name).join(', ')}, 是否继续?`,
            preview,
            `目标目录: ${target}`
        );
        if (!ok) {
            vscode.window.showInformationMessage('已取消, 未写入任何文件.');
            return;
        }
    }
    const written = writeConfigPlan(changed);
    output.appendLine(`[配置] 已写入: ${written.join(', ')}`);
    vscode.window.showInformationMessage(`已生成/修正编辑器配置: ${written.join(', ')}`);
}
