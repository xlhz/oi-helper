import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

// 定位 oi-judge: OI_JUDGE_PATH 优先, 否则 core/build/
function resolveJudgePath() {
    if (process.env.OI_JUDGE_PATH && process.env.OI_JUDGE_PATH.trim()) {
        return process.env.OI_JUDGE_PATH.trim();
    }
    const isWin = process.platform === 'win32';
    const names = isWin ? ['oi-judge.exe', 'oi-judge'] : ['oi-judge', 'oi-judge.exe'];
    const roots = [process.cwd(), repoRoot];
    for (const root of roots) {
        for (const name of names) {
            const candidate = path.join(root, 'core', 'build', name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    throw new Error('未找到 oi-judge. 请设置环境变量 OI_JUDGE_PATH 或将其放到 core/build/ 下.');
}

// 运行 oi-judge, 始终 resolve 出退出码与输出
function runJudge(exe, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => reject(new Error(`无法启动 oi-judge: ${err.message}`)));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function execJudge(args) {
    const exe = resolveJudgePath();
    const { code, stdout, stderr } = await runJudge(exe, args);
    if (code === 2) {
        throw new Error(`oi-judge 编译环境不可用 (exit 2).\n${stderr || stdout}`);
    }
    if (code === 1) {
        throw new Error(`oi-judge 用法/内部错误 (exit 1).\n${stderr || stdout}`);
    }
    if (code !== 0) {
        throw new Error(`oi-judge 退出码 ${code}.\n${stderr || stdout}`);
    }
    return stdout;
}

async function judgeProblem(request) {
    const args = request ?? {};
    if (!args.problemDir) {
        throw new Error('缺少参数 problemDir.');
    }
    const tmp = path.join(os.tmpdir(), `oi-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cliArgs = ['--problem', args.problemDir, '--json', tmp, '--pretty'];
    if (args.env) cliArgs.push('--env', String(args.env));
    if (args.jobs !== undefined) cliArgs.push('--jobs', String(args.jobs));
    if (args.timeLimit !== undefined) cliArgs.push('--time', String(args.timeLimit));
    if (args.memoryLimit !== undefined) cliArgs.push('--memory', String(args.memoryLimit));
    try {
        await execJudge(cliArgs);
        return fs.readFileSync(tmp, 'utf8');
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

async function judgeFile(request) {
    const args = request ?? {};
    if (!args.src || !args.input || !args.expected) {
        throw new Error('缺少参数 src/input/expected.');
    }
    const tmp = path.join(os.tmpdir(), `oi-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cliArgs = ['--src', args.src, '--in', args.input, '--out', args.expected, '--json', tmp, '--pretty'];
    if (args.env) cliArgs.push('--env', String(args.env));
    if (args.timeLimit !== undefined) cliArgs.push('--time', String(args.timeLimit));
    if (args.memoryLimit !== undefined) cliArgs.push('--memory', String(args.memoryLimit));
    try {
        await execJudge(cliArgs);
        return fs.readFileSync(tmp, 'utf8');
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

async function judgeVersion() {
    const exe = resolveJudgePath();
    const { code, stdout, stderr } = await runJudge(exe, ['--version']);
    if (code !== 0) {
        throw new Error(`oi-judge --version 失败 (exit ${code}).\n${stderr || stdout}`);
    }
    return stdout.trim() || stderr.trim();
}

const TOOLS = [
    {
        name: 'judge_problem',
        description: '评测一个题目目录 (读取 problem.json), 返回评测结果 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                problemDir: { type: 'string', description: '题目目录路径.' },
                env: { type: 'string', enum: ['auto', 'wsl', 'mingw'], description: '评测环境.' },
                jobs: { type: 'number', description: '并行度.' },
                timeLimit: { type: 'number', description: '时限 (ms).' },
                memoryLimit: { type: 'number', description: '内存限制 (MB).' }
            },
            required: ['problemDir']
        }
    },
    {
        name: 'judge_file',
        description: '评测单个源文件, 返回评测结果 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                src: { type: 'string', description: '源文件路径 (.cpp).' },
                input: { type: 'string', description: '测试点输入文件.' },
                expected: { type: 'string', description: '测试点预期输出文件.' },
                timeLimit: { type: 'number', description: '时限 (ms).' },
                memoryLimit: { type: 'number', description: '内存限制 (MB).' },
                env: { type: 'string', enum: ['auto', 'wsl', 'mingw'], description: '评测环境.' }
            },
            required: ['src', 'input', 'expected']
        }
    },
    {
        name: 'judge_version',
        description: '返回 oi-judge --version 的版本信息.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

const server = new Server(
    { name: 'oi-helper-mcp', version: '0.0.1' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
        let text;
        if (name === 'judge_problem') {
            text = await judgeProblem(args);
        } else if (name === 'judge_file') {
            text = await judgeFile(args);
        } else if (name === 'judge_version') {
            text = await judgeVersion();
        } else {
            throw new Error(`未知工具: ${name}`);
        }
        return { content: [{ type: 'text', text }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${err.message}` }], isError: true };
    }
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

export { server };
