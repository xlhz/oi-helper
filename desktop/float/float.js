'use strict';

const state = {
    snapshot: null,
    lastResult: null,
    busy: false,
    message: ''
};

const $ = (selector) => document.querySelector(selector);

function setStatus(text, isError) {
    state.message = text || '';
    const node = $('#statusline');
    node.textContent = state.message;
    node.classList.toggle('error', Boolean(isError));
}

function formatTime(ms) {
    return Number.isFinite(Number(ms)) ? `${Number(ms)} ms` : '';
}

function formatMemory(kb) {
    return Number.isFinite(Number(kb)) ? `${Number(kb)} KB` : '';
}

function statusClass(status) {
    return /^(AC|WA|RE|TLE|MLE|CE|OLE|PE|SE)$/.test(String(status || '')) ? String(status) : 'idle';
}

function problemTitle() {
    const problem = state.snapshot && state.snapshot.problem;
    return problem ? `${problem.name}${problem.type ? ` · ${problem.type}` : ''}` : '未选择题目';
}

function renderMeta() {
    const snapshot = state.snapshot;
    const problem = snapshot && snapshot.problem;
    if (!problem) {
        $('#meta').textContent = snapshot && snapshot.problemDir
            ? `题目配置不可读: ${snapshot.problemDir}`
            : '选择 problems 下的题目目录后开始.';
        return;
    }
    const parts = [
        `时限 ${problem.timeLimit || '-'} ms`,
        `内存 ${problem.memoryLimit || '-'} MB`,
        `测试点 ${problem.tests.length}`
    ];
    $('#meta').textContent = `${snapshot.problemDir} · ${parts.join(' · ')}`;
}

function selectedIds() {
    return [...document.querySelectorAll('.test-check')]
        .filter((node) => node.checked)
        .map((node) => Number(node.dataset.id));
}

function resultOfTest(run, id) {
    if (!run || !Array.isArray(run.tests)) {
        return null;
    }
    return run.tests.find((item) => Number(item.id) === Number(id)) || null;
}

function renderTests() {
    const list = $('#test-list');
    list.textContent = '';
    const problem = state.snapshot && state.snapshot.problem;
    const tests = problem ? problem.tests : [];
    const persisted = state.snapshot ? state.snapshot.selectedTests : null;
    const selected = Array.isArray(persisted) ? persisted : tests.map((item) => item.id);
    const run = state.lastResult || (state.snapshot && state.snapshot.lastRun);
    for (const test of tests) {
        const item = document.createElement('li');
        item.className = 'test-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'test-check';
        checkbox.dataset.id = String(test.id);
        checkbox.checked = selected.includes(test.id);
        checkbox.addEventListener('change', () => {
            const ids = selectedIds();
            if (!ids.length) {
                checkbox.checked = true;
                setStatus('至少保留一个测试点.', true);
                return;
            }
            window.oih.floatSetSelection(ids).then((snapshot) => {
                state.snapshot = snapshot;
                render();
            }).catch((err) => setStatus(err.message, true));
        });
        const label = document.createElement('span');
        label.textContent = `#${test.id}`;
        item.append(checkbox, label);
        const result = resultOfTest(run, test.id);
        if (result) {
            const badge = document.createElement('span');
            badge.className = `state ${statusClass(result.status)}`;
            badge.textContent = result.status;
            item.append(badge);
        }
        list.append(item);
    }
    $('#test-empty').hidden = tests.length > 0;
    const all = tests.length > 0 && selected.length === tests.length;
    const some = selected.length > 0 && !all;
    const checkAll = $('#check-all');
    checkAll.checked = all;
    checkAll.indeterminate = some;
    checkAll.disabled = !tests.length;
}

function renderRun(target, run, emptyText) {
    const summary = $(target.summary);
    const tests = $(target.tests);
    tests.textContent = '';
    if (!run) {
        summary.textContent = emptyText;
        return;
    }
    summary.textContent = `${run.problem || '题目'} · ${run.status || '-'} · 得分 ${run.totalScore ?? '-'} / ${run.maxScore ?? '-'}`;
    for (const test of run.tests || []) {
        const badge = document.createElement('span');
        const time = formatTime(test.timeMs);
        const memory = formatMemory(test.memoryKb);
        badge.className = `state ${statusClass(test.status)}`;
        badge.textContent = `#${test.id} ${test.status}${time ? ` ${time}` : ''}${memory ? ` ${memory}` : ''}`;
        tests.append(badge);
    }
}

function renderResult() {
    const run = state.lastResult || (state.snapshot && state.snapshot.lastRun);
    const chip = $('#result-chip');
    if (!run) {
        chip.className = 'chip idle';
        chip.textContent = '未评测';
        renderRun({ summary: '#result-summary', tests: '#result-tests' }, null, '点击「一键评测」运行全部或勾选的测试点.');
        return;
    }
    chip.className = `chip ${statusClass(run.status)}`;
    chip.textContent = run.status || '完成';
    renderRun({ summary: '#result-summary', tests: '#result-tests' }, run, '');
}

function renderLastRun() {
    const run = state.snapshot && state.snapshot.lastRun;
    $('#last-time').textContent = run && run.ts ? new Date(run.ts).toLocaleString('zh-CN') : '';
    renderRun({ summary: '#last-summary', tests: '#result-tests-last' }, run, '暂无记录.');
}

function render() {
    $('#problem-title').textContent = problemTitle();
    renderMeta();
    renderTests();
    renderResult();
    renderLastRun();
    $('#btn-judge').disabled = state.busy || !(state.snapshot && state.snapshot.problem);
}

async function load() {
    state.snapshot = await window.oih.floatState();
    state.lastResult = state.snapshot.lastRun || null;
    render();
}

async function pickProblem() {
    try {
        const response = await window.oih.floatPickProblem();
        if (response && response.state) {
            state.snapshot = response.state;
            state.lastResult = null;
            render();
        }
    } catch (err) {
        setStatus(err.message, true);
    }
}

async function openProblem() {
    try {
        const result = await window.oih.floatOpenProblem();
        if (result && result.ok) {
            setStatus(`已打开: ${result.target}`);
        } else {
            setStatus(result && result.error ? result.error : '打开题目失败.', true);
        }
    } catch (err) {
        setStatus(err.message, true);
    }
}

async function runJudge() {
    const ids = selectedIds();
    if (!ids.length) {
        setStatus('请至少勾选一个测试点.', true);
        return;
    }
    state.busy = true;
    render();
    setStatus('评测中, 请稍候...');
    try {
        const response = await window.oih.floatJudge({ tests: ids });
        state.snapshot = response.state;
        state.lastResult = response.result;
        setStatus(`评测完成: ${response.result.status} ${response.result.totalScore}/${response.result.maxScore}`);
    } catch (err) {
        setStatus(err.message, true);
    } finally {
        state.busy = false;
        render();
    }
}

$('#btn-pick').addEventListener('click', pickProblem);
$('#btn-open').addEventListener('click', openProblem);
$('#btn-judge').addEventListener('click', runJudge);
$('#btn-minimize').addEventListener('click', () => window.oih.floatMinimize());
$('#btn-close').addEventListener('click', () => window.oih.floatClose());
$('#check-all').addEventListener('change', (event) => {
    const checked = event.target.checked;
    const ids = [...document.querySelectorAll('.test-check')].map((node) => Number(node.dataset.id));
    window.oih.floatSetSelection(checked ? ids : []).then((snapshot) => {
        state.snapshot = snapshot;
        render();
    }).catch((err) => setStatus(err.message, true));
});

window.oih.onFloatState((snapshot) => {
    if (!snapshot) {
        return;
    }
    state.snapshot = snapshot;
    if (!state.busy) {
        state.lastResult = snapshot.lastRun || state.lastResult;
    }
    render();
});

load().catch((err) => setStatus(`加载失败: ${err.message}`, true));
