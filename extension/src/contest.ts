import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ContestProblem {
    label: string;
    title: string;
    dir: string;
    available: boolean;
}

export interface ContestConfig {
    name: string;
    format: string;
    durationMinutes: number;
    penaltyMinutes: number;
    freezeMinutes: number;
    problems: ContestProblem[];
}

export interface Submission {
    label: string;
    atMs: number;
    status: string;
}

export interface OpponentTeam {
    name: string;
    solved: number;
    penalty: number;
}

export interface ContestState {
    status: 'idle' | 'running' | 'paused' | 'ended';
    accumulatedMs: number;
    startedAt: number;
    submissions: Submission[];
    opponents: OpponentTeam[];
}

export interface ProblemStat {
    label: string;
    solved: boolean;
    acMinute?: number;
    wrongCount: number;
    penalty: number;
}

export interface TeamRow {
    name: string;
    solved: number;
    penalty: number;
    isSelf: boolean;
}

export interface ContestSnapshot {
    config?: ContestConfig;
    state: ContestState;
    elapsedMs: number;
    remainingMs: number;
    frozen: boolean;
    problemStats: ProblemStat[];
    ranklist: TeamRow[];
}

// 初始状态: idle 且无任何记录
function initialState(): ContestState {
    return { status: 'idle', accumulatedMs: 0, startedAt: 0, submissions: [], opponents: [] };
}

// 读 JSON: 缺失/解析失败返回 undefined, 不抛错
function readJson(file: string): unknown {
    try {
        if (!fs.existsSync(file)) {
            return undefined;
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

// label 缺省: 按 A, B, C ... 生成, 超出 26 用序号
function labelFromIndex(index: number): string {
    if (index >= 0 && index < 26) {
        return String.fromCharCode(65 + index);
    }
    return String(index + 1);
}

// 罚时缺省: 优先读 vscode 配置, 读不到用 20
function configPenaltyMinutes(): number {
    try {
        const value = vscode.workspace.getConfiguration('oiHelper').get<number>('contestPenaltyMinutes');
        if (typeof value === 'number' && value >= 0) {
            return value;
        }
    } catch { /* 非扩展环境忽略 */ }
    return 20;
}

// 封榜时长缺省: 优先读 vscode 配置, 读不到用 0(不封榜)
function configFreezeMinutes(): number {
    try {
        const value = vscode.workspace.getConfiguration('oiHelper').get<number>('contestFreezeMinutes');
        if (typeof value === 'number' && value >= 0) {
            return value;
        }
    } catch { /* 非扩展环境忽略 */ }
    return 0;
}

// 载入 contest.json; 缺失字段用默认值补齐
export function loadContest(dir: string): ContestConfig {
    const raw = (readJson(path.join(dir, 'contest.json')) ?? {}) as {
        name?: unknown;
        format?: unknown;
        durationMinutes?: unknown;
        penaltyMinutes?: unknown;
        freezeMinutes?: unknown;
        problems?: unknown;
    };
    const problemsRaw = Array.isArray(raw.problems) ? raw.problems : [];
    const problems: ContestProblem[] = problemsRaw.map((item, index) => {
        const p = (item ?? {}) as { label?: unknown; title?: unknown; dir?: unknown };
        const relDir = typeof p.dir === 'string' ? p.dir : '';
        const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : labelFromIndex(index);
        const available = relDir !== '' && fs.existsSync(path.join(path.resolve(dir, relDir), 'problem.json'));
        return {
            label,
            title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : label,
            dir: relDir,
            available
        };
    });
    return {
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : path.basename(dir),
        format: typeof raw.format === 'string' && raw.format.trim() ? raw.format.trim() : 'icpc',
        durationMinutes: typeof raw.durationMinutes === 'number' && raw.durationMinutes > 0 ? raw.durationMinutes : 300,
        penaltyMinutes: typeof raw.penaltyMinutes === 'number' && raw.penaltyMinutes >= 0 ? raw.penaltyMinutes : configPenaltyMinutes(),
        freezeMinutes: typeof raw.freezeMinutes === 'number' && raw.freezeMinutes >= 0 ? raw.freezeMinutes : configFreezeMinutes(),
        problems
    };
}

// 载入 contest-state.json; 缺失/解析失败回退初始状态
function loadState(dir: string): ContestState {
    const raw = readJson(path.join(dir, 'contest-state.json')) as Partial<ContestState> | undefined;
    if (!raw || typeof raw !== 'object') {
        return initialState();
    }
    const status = raw.status === 'running' || raw.status === 'paused' || raw.status === 'ended' ? raw.status : 'idle';
    return {
        status,
        accumulatedMs: typeof raw.accumulatedMs === 'number' ? raw.accumulatedMs : 0,
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
        submissions: Array.isArray(raw.submissions) ? raw.submissions : [],
        opponents: Array.isArray(raw.opponents) ? raw.opponents : []
    };
}

// 已用时间: running 时叠加当前段
export function elapsedMs(state: ContestState, now: number = Date.now()): number {
    return state.status === 'running' ? state.accumulatedMs + (now - state.startedAt) : state.accumulatedMs;
}

// 封榜开始时刻(ms): 比赛结束前 freezeMinutes 分钟; freezeMinutes<=0 表示不封榜
export function freezeStartMs(config: ContestConfig): number {
    return Math.max(0, config.durationMinutes - config.freezeMinutes) * 60000;
}

// 每题统计: 首次 AC 计通过, AC 前的非 AC 计罚时; cutoffMs 给出时仅统计封榜前的提交
export function computeProblemStats(state: ContestState, config: ContestConfig, cutoffMs?: number): ProblemStat[] {
    return config.problems.map((problem) => {
        const subs = state.submissions.filter(
            (s) => s.label === problem.label && (cutoffMs === undefined || s.atMs <= cutoffMs)
        );
        const acIndex = subs.findIndex((s) => s.status === 'AC');
        if (acIndex >= 0) {
            const acMinute = Math.floor(subs[acIndex].atMs / 60000);
            const wrongCount = subs.slice(0, acIndex).filter((s) => s.status !== 'AC').length;
            return {
                label: problem.label,
                solved: true,
                acMinute,
                wrongCount,
                penalty: acMinute + config.penaltyMinutes * wrongCount
            };
        }
        const wrongCount = subs.filter((s) => s.status !== 'AC').length;
        return { label: problem.label, solved: false, wrongCount, penalty: 0 };
    });
}

// 榜单: 本队 + 对手, 按通过数降序、罚时升序; cutoffMs 给出时仅统计封榜前的提交
export function computeRanklist(state: ContestState, config: ContestConfig, cutoffMs?: number): TeamRow[] {
    const stats = computeProblemStats(state, config, cutoffMs);
    const solved = stats.filter((s) => s.solved).length;
    const penalty = stats.reduce((sum, s) => sum + s.penalty, 0);
    const rows: TeamRow[] = [{ name: '本队', solved, penalty, isSelf: true }];
    for (const opponent of state.opponents) {
        rows.push({ name: opponent.name, solved: opponent.solved, penalty: opponent.penalty, isSelf: false });
    }
    rows.sort((a, b) => (b.solved - a.solved) || (a.penalty - b.penalty));
    return rows;
}

// 比赛模型: 管理目录、配置、状态与快照
export class ContestModel {
    readonly dir: string;

    config: ContestConfig | undefined;

    state: ContestState;

    constructor(dir: string, private readonly output: vscode.OutputChannel) {
        this.dir = dir;
        this.state = initialState();
    }

    // 载入 contest.json 并恢复状态
    load(): ContestConfig {
        this.config = loadContest(this.dir);
        this.state = loadState(this.dir);
        this.output.appendLine(`[比赛] 载入 ${this.config.name} (${this.config.problems.length} 题)`);
        return this.config;
    }

    start(): void {
        if (this.state.status === 'running') {
            return;
        }
        this.state.status = 'running';
        this.state.startedAt = Date.now();
    }

    pause(): void {
        if (this.state.status !== 'running') {
            return;
        }
        this.state.accumulatedMs += Date.now() - this.state.startedAt;
        this.state.startedAt = 0;
        this.state.status = 'paused';
    }

    end(): void {
        if (this.state.status === 'running') {
            this.state.accumulatedMs += Date.now() - this.state.startedAt;
            this.state.startedAt = 0;
        }
        this.state.status = 'ended';
    }

    reset(): void {
        this.state = initialState();
    }

    // 记录提交: 仅比赛进行中有效
    recordSubmission(label: string, status: string, now: number = Date.now()): void {
        if (this.state.status !== 'running') {
            return;
        }
        this.state.submissions.push({ label, atMs: elapsedMs(this.state, now), status });
        this.save();
    }

    addOpponent(name: string, solved: number, penalty: number): void {
        this.state.opponents.push({ name, solved, penalty });
    }

    snapshot(now: number = Date.now()): ContestSnapshot {
        const config = this.config;
        const elapsed = elapsedMs(this.state, now);
        const frozen = !!config && config.freezeMinutes > 0 && this.state.status === 'running'
            && elapsed >= freezeStartMs(config);
        const cutoff = frozen && config ? freezeStartMs(config) : undefined;
        return {
            config,
            state: this.state,
            elapsedMs: elapsed,
            remainingMs: config ? config.durationMinutes * 60000 - elapsed : 0,
            frozen,
            problemStats: config ? computeProblemStats(this.state, config, cutoff) : [],
            ranklist: config ? computeRanklist(this.state, config, cutoff) : []
        };
    }

    save(): void {
        try {
            fs.writeFileSync(path.join(this.dir, 'contest-state.json'), JSON.stringify(this.state, null, 4), 'utf8');
        } catch (err) {
            this.output.appendLine(`[错误] 保存比赛状态失败: ${String(err)}`);
        }
    }
}