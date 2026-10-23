import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface EnvCheckItem {
    id: string;
    title: string;
    ok: boolean;
    detail: string;
    suggestion: string;
}

export interface EnvCheckOptions {
    cwd: string;
    standard: string;
    fastIO: string;
}

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    error: string;
}

function run(exe: string, args: string[], input = ''): RunResult {
    const result = cp.spawnSync(exe, args, {
        input,
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024
    });
    return {
        code: typeof result.status === 'number' ? result.status : -1,
        stdout: result.stdout ? String(result.stdout) : '',
        stderr: result.stderr ? String(result.stderr) : '',
        error: result.error ? result.error.message : ''
    };
}

// 按 PATH 与 PATHEXT 查找可执行文件, 不硬编码安装位置
export function findExecutable(name: string): string | undefined {
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext.toLowerCase());
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

// 读取 g++ 的 include 搜索路径, 用于 bits/stdc++.h 与配置生成
export function queryIncludePaths(compiler: string): string[] {
    const result = run(compiler, ['-E', '-v', '-x', 'c++', '-']);
    const startMark = '#include <...> search starts here:';
    const start = result.stderr.indexOf(startMark);
    if (start < 0) {
        return [];
    }
    const end = result.stderr.indexOf('End of search list.', start);
    const block = result.stderr.slice(start + startMark.length, end < 0 ? undefined : end);
    return block
        .split(/\r?\n/)
        .map((line) => line.replace(/\(.*\)\s*$/, '').trim())
        .filter((line) => line.length > 0);
}

function compilerVersion(compiler: string): { ok: boolean; detail: string } {
    const result = run(compiler, ['--version']);
    const text = (result.stdout || result.stderr).trim();
    if (result.code !== 0 || !text) {
        return { ok: false, detail: result.error || text || '无法执行 g++ --version' };
    }
    return { ok: true, detail: text.split(/\r?\n/)[0] };
}

function probeStandard(compiler: string, standard: string): boolean {
    return run(compiler, [`-std=${standard}`, '-fsyntax-only', '-x', 'c++', '-'], 'int main(){return 0;}\n').code === 0;
}

function probeBits(compiler: string): { ok: boolean; detail: string } {
    const result = run(compiler, ['-std=c++17', '-fsyntax-only', '-x', 'c++', '-'], '#include <bits/stdc++.h>\nint main(){return 0;}\n');
    if (result.code === 0) {
        return { ok: true, detail: '包含 bits/stdc++.h 的源文件可编译' };
    }
    const text = (result.stderr || result.error || '编译探测失败').trim().split(/\r?\n/)[0];
    return { ok: false, detail: text };
}

function consoleCodePage(): string {
    if (process.platform !== 'win32') {
        return 'n/a';
    }
    const result = run('chcp.com', []);
    const hit = /(\d{3,5})/.exec(`${result.stdout}${result.stderr}`);
    return hit ? hit[1] : 'unknown';
}

function templateCandidates(cwd: string): string[] {
    return [
        path.join(cwd, '.oihelper', 'template.cpp'),
        path.join(cwd, 'template.cpp'),
        path.join(cwd, 'templates', 'main.cpp')
    ];
}

export function collectEnvCheck(options: EnvCheckOptions): EnvCheckItem[] {
    const items: EnvCheckItem[] = [];
    const compiler = findExecutable('g++');
    const version = compiler ? compilerVersion(compiler) : { ok: false, detail: '未在 PATH 中找到 g++' };

    items.push({
        id: 'compiler',
        title: '编译器 g++',
        ok: Boolean(compiler) && version.ok,
        detail: compiler ? `${compiler}; ${version.detail}` : version.detail,
        suggestion: '安装 MinGW-w64 (建议 x86_64-posix-seh), 并把其 bin 目录加入 PATH; 只装 VS Code 不带编译器.'
    });

    const standards = compiler ? ['c++11', 'c++14', 'c++17', 'c++20'].filter((s) => probeStandard(compiler, s)) : [];
    const wanted = options.standard || 'c++14';
    items.push({
        id: 'standard',
        title: 'C++ 标准支持',
        ok: standards.includes(wanted),
        detail: standards.length > 0 ? `可用: ${standards.join(', ')}; 当前配置: ${wanted}` : '无法探测 (编译器不可用)',
        suggestion: standards.length > 0
            ? `把 oiHelper.standard 设为受支持的版本, 如 ${standards[standards.length - 1]}`
            : '先修复编译器, 再重新体检.'
    });

    const bits = compiler ? probeBits(compiler) : { ok: false, detail: '编译器不可用, 未探测' };
    items.push({
        id: 'bits',
        title: 'bits/stdc++.h',
        ok: bits.ok,
        detail: bits.detail,
        suggestion: '使用 mingw-w64 完整发行版; 若确实没有该头文件, 改用 <iostream>/<algorithm> 等标准头.'
    });

    const includes = compiler ? queryIncludePaths(compiler) : [];
    items.push({
        id: 'includePath',
        title: 'include 路径',
        ok: includes.length > 0,
        detail: includes.length > 0 ? includes.join('; ') : '未解析到 include 搜索路径',
        suggestion: '检查 g++ 安装是否完整; 生成编辑器配置时会把这些路径写入 c_cpp_properties.json.'
    });

    const codePage = consoleCodePage();
    items.push({
        id: 'encoding',
        title: '终端编码',
        ok: codePage === '65001' || codePage === 'n/a',
        detail: `当前控制台代码页: ${codePage}`,
        suggestion: '在终端先执行 chcp 65001, 或在 Windows 区域设置中启用 UTF-8; 输出中文乱码多由此引起.'
    });

    items.push({
        id: 'stack',
        title: '栈大小',
        ok: true,
        detail: process.platform === 'win32' ? 'Windows 主线程默认栈约 1 MB (MinGW)' : '使用系统默认栈',
        suggestion: '深递归题目在编译参数加 -Wl,--stack,268435456, 或改写成迭代.'
    });

    items.push({
        id: 'timePrecision',
        title: '时间精度',
        ok: true,
        detail: process.platform === 'win32'
            ? 'steady_clock 在 Windows 使用 QPC (约 100ns); clock() 精度约 1ms'
            : 'steady_clock 使用单调时钟',
        suggestion: '计时统一用 std::chrono::steady_clock, 不要用 clock() 或 time(0).'
    });

    const candidates = templateCandidates(options.cwd);
    const found = candidates.find((file) => fs.existsSync(file));
    const fastIO = (options.fastIO || '').trim();
    items.push({
        id: 'template',
        title: '代码模板',
        ok: Boolean(found),
        detail: found
            ? `模板: ${found}${fastIO ? '; 快读快写片段已配置' : '; 快读快写片段为空'}`
            : `未找到模板 (查找: ${candidates.join(', ')})${fastIO ? '; 快读快写片段已配置' : '; 快读快写片段为空'}`,
        suggestion: `在 ${path.join(options.cwd, '.oihelper', 'template.cpp')} 放一份 main 骨架, 并在设置中填写 oiHelper.fastIO.`
    });

    return items;
}

// 体检结果同时写入输出面板与 QuickPick, 缺失项附建议
export async function runEnvCheckCommand(output: vscode.OutputChannel): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders && folders.length > 0 ? folders[0].uri.fsPath : os.homedir();
    const cfg = vscode.workspace.getConfiguration('oiHelper');
    const items = collectEnvCheck({
        cwd,
        standard: cfg.get<string>('standard', 'c++14'),
        fastIO: cfg.get<string>('fastIO', '')
    });
    for (const item of items) {
        const line = `[体检] ${item.ok ? '通过' : '缺失'} ${item.title}: ${item.detail}`;
        output.appendLine(item.ok || !item.suggestion ? line : `${line} | 建议: ${item.suggestion}`);
    }
    output.show(true);
    const passed = items.filter((item) => item.ok).length;
    const picks = items.map((item) => ({
        label: `${item.ok ? '✔' : '✘'} ${item.title}`,
        description: item.detail,
        detail: item.ok ? '' : `建议: ${item.suggestion}`,
        item
    }));
    const selected = await vscode.window.showQuickPick(picks, {
        title: `C++ 环境体检 (${passed}/${items.length} 通过)`,
        placeHolder: '选中缺失项查看建议, Esc 关闭',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (selected && !selected.item.ok) {
        await vscode.window.showInformationMessage(`${selected.item.title}: ${selected.item.suggestion}`);
    }
}
