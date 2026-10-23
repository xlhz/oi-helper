(function () {
    const HOST_ID = 'oih-ide-panel-host';
    const STATUS_LABELS = {
        AC: '通过',
        WA: '答案错误',
        TLE: '超时',
        MLE: '内存超限',
        RE: '运行错误',
        CE: '编译错误',
        OLE: '输出超限',
        PE: '格式错误',
        PC: '部分正确',
        SE: '系统错误',
        UKE: '未知错误',
        SKIPPED: '跳过'
    };
    const SOURCE_LABELS = {
        monaco: 'Monaco',
        codemirror5: 'CodeMirror 5',
        codemirror6: 'CodeMirror 6',
        textarea: 'textarea'
    };

    const state = {
        mounted: false,
        collapsed: true,
        loaded: false,
        busy: false,
        problem: null,
        problemError: '',
        tests: [],
        customSeq: 0,
        code: '',
        codeSource: '',
        codeError: '',
        judge: null,
        judgeError: '',
        query: null,
        queryError: ''
    };

    let refs = null;
    let stylePromise = null;

    function send(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    resolve({ ok: false, error: `后台未响应: ${error.message}` });
                    return;
                }
                resolve(response || { ok: false, error: '后台未返回结果.' });
            });
        });
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function adapters() {
        return typeof OIHIdeAdapters !== 'undefined' ? OIHIdeAdapters : null;
    }

    function currentAdapter() {
        const registry = adapters();
        return registry ? registry.resolve(location.href, document) : null;
    }

    function loadStyleText() {
        if (!stylePromise) {
            stylePromise = fetch(chrome.runtime.getURL('content/panel.css'))
                .then((response) => (response.ok ? response.text() : ''))
                .catch(() => '');
        }
        return stylePromise;
    }

    async function injectStyle(shadow) {
        const css = await loadStyleText();
        if (!css) {
            return;
        }
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            shadow.adoptedStyleSheets = [sheet];
        } catch (error) {
            const style = el('style');
            style.textContent = css;
            shadow.appendChild(style);
        }
    }

    function showMessage(text, danger) {
        if (!refs) {
            return;
        }
        const value = String(text || '');
        refs.msg.textContent = value;
        refs.msg.className = `oih-msg${danger ? ' oih-msg-danger' : ''}${value ? '' : ' oih-hidden'}`;
    }

    function setBusy(busy) {
        state.busy = busy;
        refs.judgeBtn.disabled = busy;
        refs.runBtn.disabled = busy;
        refs.submitBtn.disabled = busy;
        refs.queryBtn.disabled = busy;
        refs.judgeBtn.textContent = busy ? '评测中...' : '评测';
        refs.runBtn.textContent = busy ? '运行中...' : '运行';
    }

    function statusLabel(status) {
        const raw = String(status || '');
        const key = raw.toUpperCase();
        if (STATUS_LABELS[key]) {
            return `${STATUS_LABELS[key]} (${raw})`;
        }
        return raw || '未返回状态';
    }

    function numberOr() {
        for (let i = 0; i < arguments.length; i += 1) {
            const value = arguments[i];
            if (value === null || value === undefined || value === '') {
                continue;
            }
            const number = Number(value);
            if (Number.isFinite(number)) {
                return number;
            }
        }
        return null;
    }

    function sliceText(value, limit) {
        const text = String(value === undefined || value === null ? '' : value);
        return text.length > limit ? `${text.slice(0, limit)}\n...` : text;
    }

    function kvRow(key, value) {
        const row = el('div', 'oih-kv-row');
        row.appendChild(el('span', 'oih-kv-key', key));
        row.appendChild(el('span', 'oih-kv-value', value));
        return row;
    }

    function buildUi(shadow) {
        const root = el('div', 'oih-root');
        const fab = el('button', 'oih-fab', 'OI');
        fab.type = 'button';
        fab.title = '打开 OI Helper 侧边面板';

        const panel = el('section', 'oih-panel oih-hidden');
        const head = el('div', 'oih-panel-head');
        const brand = el('div', 'oih-brand');
        brand.appendChild(el('span', 'oih-brand-name', 'OI Helper'));
        const badge = el('span', 'oih-badge oih-badge-off', '在线 IDE');
        brand.appendChild(badge);
        const collapseBtn = el('button', 'oih-icon-btn', '收起');
        collapseBtn.type = 'button';
        head.appendChild(brand);
        head.appendChild(collapseBtn);

        const msg = el('div', 'oih-msg oih-hidden');
        const body = el('div', 'oih-body');

        const problemCard = el('section', 'oih-card');
        const problemHead = el('div', 'oih-card-head');
        problemHead.appendChild(el('span', 'oih-card-title', '题目'));
        const problemRefreshBtn = el('button', 'oih-small-btn', '刷新题目');
        problemRefreshBtn.type = 'button';
        problemHead.appendChild(problemRefreshBtn);
        const problemBox = el('div');
        problemCard.appendChild(problemHead);
        problemCard.appendChild(problemBox);

        const testsCard = el('section', 'oih-card');
        const testsHead = el('div', 'oih-card-head');
        testsHead.appendChild(el('span', 'oih-card-title', '测试点'));
        const addTestBtn = el('button', 'oih-small-btn', '新增测试点');
        addTestBtn.type = 'button';
        testsHead.appendChild(addTestBtn);
        const testsBox = el('div');
        const testsHint = el('div', 'oih-hint', '勾选表示该测试点参与标记; 评测按桌面题目目录中的测试点执行.');
        testsCard.appendChild(testsHead);
        testsCard.appendChild(testsBox);
        testsCard.appendChild(testsHint);

        const codeCard = el('section', 'oih-card');
        const codeHead = el('div', 'oih-card-head');
        codeHead.appendChild(el('span', 'oih-card-title', '代码'));
        const codeRefreshBtn = el('button', 'oih-small-btn', '刷新代码');
        codeRefreshBtn.type = 'button';
        codeHead.appendChild(codeRefreshBtn);
        const codeMeta = el('div', 'oih-code-meta', '尚未读取代码.');
        const codeBox = el('div');
        codeCard.appendChild(codeHead);
        codeCard.appendChild(codeMeta);
        codeCard.appendChild(codeBox);

        const judgeCard = el('section', 'oih-card');
        const judgeHead = el('div', 'oih-card-head');
        judgeHead.appendChild(el('span', 'oih-card-title', '评测与提交'));
        const judgeActions = el('div', 'oih-card-actions');
        const runBtn = el('button', 'oih-btn', '运行');
        runBtn.type = 'button';
        const judgeBtn = el('button', 'oih-btn oih-btn-primary', '评测');
        judgeBtn.type = 'button';
        const submitBtn = el('button', 'oih-btn', '提交');
        submitBtn.type = 'button';
        const queryBtn = el('button', 'oih-btn', '查询结果');
        queryBtn.type = 'button';
        judgeActions.appendChild(runBtn);
        judgeActions.appendChild(judgeBtn);
        judgeActions.appendChild(submitBtn);
        judgeActions.appendChild(queryBtn);
        judgeHead.appendChild(judgeActions);
        const judgeBox = el('div');
        judgeCard.appendChild(judgeHead);
        judgeCard.appendChild(judgeBox);

        body.appendChild(problemCard);
        body.appendChild(testsCard);
        body.appendChild(codeCard);
        body.appendChild(judgeCard);
        panel.appendChild(head);
        panel.appendChild(msg);
        panel.appendChild(body);
        root.appendChild(fab);
        root.appendChild(panel);
        shadow.appendChild(root);

        refs = {
            root,
            fab,
            panel,
            badge,
            msg,
            problemBox,
            problemRefreshBtn,
            testsBox,
            addTestBtn,
            codeMeta,
            codeBox,
            codeRefreshBtn,
            runBtn,
            judgeBtn,
            submitBtn,
            queryBtn,
            judgeBox,
            collapseBtn
        };

        fab.addEventListener('click', expand);
        collapseBtn.addEventListener('click', collapse);
        problemRefreshBtn.addEventListener('click', () => loadProblem(true));
        addTestBtn.addEventListener('click', addCustomTest);
        codeRefreshBtn.addEventListener('click', () => loadCode(true));
        runBtn.addEventListener('click', runFirstTest);
        judgeBtn.addEventListener('click', runJudge);
        submitBtn.addEventListener('click', submit);
        queryBtn.addEventListener('click', queryResult);

        renderProblem();
        renderTests();
        renderCode();
        renderJudge();
    }

    function expand() {
        state.collapsed = false;
        refs.fab.classList.add('oih-hidden');
        refs.panel.classList.remove('oih-hidden');
        if (!state.loaded) {
            state.loaded = true;
            loadProblem(false);
            loadCode(false);
        }
    }

    function collapse() {
        state.collapsed = true;
        refs.panel.classList.add('oih-hidden');
        refs.fab.classList.remove('oih-hidden');
    }

    function setBadge(text, ok) {
        if (!refs) {
            return;
        }
        refs.badge.textContent = text;
        refs.badge.className = `oih-badge${ok ? '' : ' oih-badge-off'}`;
    }

    function mergeSamples(samples) {
        const previous = new Map();
        for (const test of state.tests) {
            if (test.source === 'sample') {
                previous.set(test.id, test);
            }
        }
        const sampleTests = (samples || []).map((sample, index) => {
            const id = `sample-${index + 1}`;
            const old = previous.get(id);
            return {
                id,
                label: `样例 ${index + 1}`,
                source: 'sample',
                input: old ? old.input : String((sample && sample.in) || ''),
                output: old ? old.output : String((sample && sample.out) || ''),
                enabled: old ? old.enabled : true
            };
        });
        state.tests = sampleTests.concat(state.tests.filter((test) => test.source !== 'sample'));
    }

    function pagePid(url) {
        const match = /\/p\/([^/?#]+)/.exec(String(url || '')) || /\/problem\/([^/?#]+)/.exec(String(url || ''));
        return match ? match[1] : '';
    }

    async function loadProblem(announce) {
        if (!refs) {
            return;
        }
        refs.problemBox.textContent = '';
        refs.problemBox.appendChild(el('div', 'oih-empty', '正在读取当前页题目...'));
        const response = await send({ type: 'panel:collect' });
        if (!response.ok) {
            state.problem = {
                name: document.title || '',
                pid: pagePid(location.href),
                url: location.href,
                samples: []
            };
            state.problemError = response.error || '题目采集失败.';
            renderProblem();
            if (announce) {
                showMessage(state.problemError, true);
            }
            return;
        }
        state.problem = response;
        state.problemError = '';
        mergeSamples(response.samples || []);
        renderProblem();
        renderTests();
        if (announce) {
            showMessage('题目已刷新.', false);
        }
    }

    function renderProblem() {
        if (!refs) {
            return;
        }
        const box = refs.problemBox;
        box.textContent = '';
        if (state.problemError) {
            if (state.problem) {
                const kv = el('div', 'oih-kv');
                kv.appendChild(kvRow('标题', state.problem.name || '(未解析)'));
                kv.appendChild(kvRow('题号', state.problem.pid || '(未解析)'));
                box.appendChild(kv);
            }
            box.appendChild(el('div', 'oih-empty oih-danger-text', state.problemError));
            box.appendChild(el('div', 'oih-hint', '可在下方测试点区手动填写测试点; 代码读取与评测不受影响.'));
            return;
        }
        const problem = state.problem;
        if (!problem) {
            box.appendChild(el('div', 'oih-empty', '尚未读取题目.'));
            return;
        }
        const kv = el('div', 'oih-kv');
        kv.appendChild(kvRow('标题', problem.name || problem.title || '(未解析)'));
        kv.appendChild(kvRow('题号', problem.pid || '(未解析)'));
        kv.appendChild(kvRow('时限', problem.timeLimit ? `${problem.timeLimit} ms` : '未解析'));
        kv.appendChild(kvRow('内存', problem.memoryLimit ? `${problem.memoryLimit} MB` : '未解析'));
        box.appendChild(kv);
        const samples = problem.samples || [];
        if (!samples.length) {
            box.appendChild(el('div', 'oih-hint', '未解析到样例测试点.'));
            return;
        }
        samples.forEach((sample, index) => {
            const details = el('details', 'oih-sample');
            details.appendChild(el('summary', '', `样例 ${index + 1}`));
            details.appendChild(el('div', 'oih-kv-key', '输入'));
            details.appendChild(el('pre', 'oih-pre', sliceText((sample && sample.in) || '(空)', 2000)));
            details.appendChild(el('div', 'oih-kv-key', '输出'));
            details.appendChild(el('pre', 'oih-pre', sliceText((sample && sample.out) || '(空)', 2000)));
            box.appendChild(details);
        });
    }

    function addCustomTest() {
        state.customSeq += 1;
        state.tests.push({
            id: `custom-${Date.now()}-${state.customSeq}`,
            label: `测试点 ${state.tests.length + 1}`,
            source: 'custom',
            input: '',
            output: '',
            enabled: true
        });
        renderTests();
    }

    function renderTests() {
        if (!refs) {
            return;
        }
        const box = refs.testsBox;
        box.textContent = '';
        if (!state.tests.length) {
            box.appendChild(el('div', 'oih-empty', '暂无测试点, 可点击「新增测试点」添加.'));
            return;
        }
        for (const test of state.tests) {
            const item = el('div', `oih-test${test.enabled ? '' : ' oih-test-off'}`);
            const head = el('div', 'oih-test-head');
            const checkLabel = el('label');
            const checkbox = el('input');
            checkbox.type = 'checkbox';
            checkbox.checked = test.enabled;
            checkbox.addEventListener('change', () => {
                test.enabled = checkbox.checked;
                item.className = `oih-test${test.enabled ? '' : ' oih-test-off'}`;
            });
            checkLabel.appendChild(checkbox);
            checkLabel.appendChild(el('span', '', '参与评测'));
            head.appendChild(checkLabel);
            head.appendChild(el('span', 'oih-test-name', test.label));
            head.appendChild(el('span', 'oih-tag', test.source === 'sample' ? '样例' : '自定义'));
            const removeBtn = el('button', 'oih-small-btn', '删除');
            removeBtn.type = 'button';
            removeBtn.addEventListener('click', () => {
                state.tests = state.tests.filter((itemTest) => itemTest.id !== test.id);
                renderTests();
            });
            head.appendChild(removeBtn);
            item.appendChild(head);

            const inputField = el('label', 'oih-field');
            inputField.appendChild(el('span', '', '输入'));
            const inputArea = el('textarea', 'oih-textarea');
            inputArea.rows = 2;
            inputArea.spellcheck = false;
            inputArea.value = test.input;
            inputArea.addEventListener('input', () => {
                test.input = inputArea.value;
            });
            inputField.appendChild(inputArea);
            item.appendChild(inputField);

            const outputField = el('label', 'oih-field');
            outputField.appendChild(el('span', '', '输出'));
            const outputArea = el('textarea', 'oih-textarea');
            outputArea.rows = 2;
            outputArea.spellcheck = false;
            outputArea.value = test.output;
            outputArea.addEventListener('input', () => {
                test.output = outputArea.value;
            });
            outputField.appendChild(outputArea);
            item.appendChild(outputField);

            box.appendChild(item);
        }
    }

    function renderCode() {
        if (!refs) {
            return;
        }
        const box = refs.codeBox;
        box.textContent = '';
        if (state.codeError) {
            refs.codeMeta.textContent = state.codeError;
            refs.codeMeta.className = 'oih-code-meta oih-danger-text';
            box.appendChild(el('div', 'oih-empty oih-danger-text', state.codeError));
            return;
        }
        if (!state.code) {
            refs.codeMeta.textContent = '尚未读取代码.';
            refs.codeMeta.className = 'oih-code-meta';
            box.appendChild(el('div', 'oih-empty', '点击「刷新代码」从编辑器读取.'));
            return;
        }
        const source = SOURCE_LABELS[state.codeSource] || state.codeSource || '未知来源';
        refs.codeMeta.textContent = `来源: ${source} · ${state.code.length} 字符 · 只读`;
        refs.codeMeta.className = 'oih-code-meta';
        box.appendChild(el('pre', 'oih-pre oih-pre-plain', sliceText(state.code, 20000)));
    }

    function readCodeIntoState() {
        if (!refs) {
            return null;
        }
        const adapter = currentAdapter();
        if (!adapter) {
            state.code = '';
            state.codeSource = '';
            state.codeError = '当前页面未检测到在线 IDE 编辑器, 无法读取代码.';
            renderCode();
            return null;
        }
        const result = adapter.getCode(document);
        if (!result.ok) {
            state.code = '';
            state.codeSource = '';
            state.codeError = result.error || '读取代码失败.';
            renderCode();
            return null;
        }
        state.code = result.code;
        state.codeSource = result.source;
        state.codeError = '';
        renderCode();
        return state.code;
    }

    async function loadCode(announce) {
        const code = readCodeIntoState();
        if (code === null && announce) {
            showMessage(state.codeError || '读取代码失败.', true);
        }
    }

    function judgeView(raw) {
        const result = raw && raw.result ? raw.result : raw || {};
        const testsRaw = result.tests || result.cases || [];
        const view = {
            status: String(result.status || ''),
            totalScore: numberOr(result.totalScore, result.score),
            maxScore: numberOr(result.maxScore, result.max),
            compileMessage: String(result.compileMessage || result.compileError || ''),
            summary: String(result.message || result.summary || ''),
            tests: testsRaw.map((test, index) => ({
                id: test.id === undefined || test.id === null ? index + 1 : test.id,
                status: String(test.status || ''),
                score: numberOr(test.score),
                maxScore: numberOr(test.maxScore),
                timeMs: numberOr(test.timeMs, test.time),
                memoryKb: numberOr(test.memoryKb, test.memory),
                message: String(test.message || test.error || ''),
                actual: test.actual !== undefined ? String(test.actual) : String(test.output || ''),
                expected: String(test.expected || ''),
                stderr: String(test.stderr || '')
            }))
        };
        if (view.totalScore === null && view.tests.length) {
            const scores = view.tests.map((test) => test.score).filter((score) => score !== null);
            if (scores.length === view.tests.length) {
                view.totalScore = scores.reduce((sum, score) => sum + score, 0);
            }
        }
        if (view.maxScore === null && view.tests.length) {
            const scores = view.tests.map((test) => test.maxScore).filter((score) => score !== null);
            if (scores.length === view.tests.length) {
                view.maxScore = scores.reduce((sum, score) => sum + score, 0);
            }
        }
        return view;
    }

    function renderJudge() {
        if (!refs) {
            return;
        }
        const box = refs.judgeBox;
        box.textContent = '';
        if (state.queryError) {
            box.appendChild(el('div', 'oih-empty oih-danger-text', state.queryError));
        }
        if (state.query) {
            const kv = el('div', 'oih-kv');
            kv.appendChild(kvRow('最近记录', state.query.name || state.query.title || '(无标题)'));
            kv.appendChild(kvRow('题号', state.query.pid || '(未解析)'));
            kv.appendChild(kvRow('来源', state.query.ruleId || '未命中规则'));
            box.appendChild(kv);
        }
        if (state.judgeError) {
            box.appendChild(el('div', 'oih-empty oih-danger-text', state.judgeError));
            return;
        }
        if (!state.judge) {
            box.appendChild(el('div', 'oih-empty', '尚未评测. 评测需要桌面程序已启动并配置令牌.'));
            return;
        }
        const view = judgeView(state.judge);
        const summary = el('div', 'oih-judge-summary');
        const statusText = statusLabel(view.status);
        const passed = String(view.status || '').toUpperCase() === 'AC';
        summary.appendChild(el('span', passed ? 'oih-ok-text' : 'oih-danger-text', statusText));
        const score = view.totalScore === null
            ? '未返回分数'
            : `${view.totalScore}${view.maxScore === null ? '' : ` / ${view.maxScore}`} 分`;
        summary.appendChild(el('span', 'oih-score', score));
        box.appendChild(summary);
        if (view.summary) {
            box.appendChild(el('div', 'oih-hint', view.summary));
        }
        if (view.compileMessage) {
            box.appendChild(el('div', 'oih-kv-key', '编译信息'));
            box.appendChild(el('pre', 'oih-pre oih-pre-plain oih-danger-text', sliceText(view.compileMessage, 2000)));
        }
        if (!view.tests.length) {
            box.appendChild(el('div', 'oih-hint', '评测结果未返回逐测试点数据.'));
            return;
        }
        for (const test of view.tests) {
            const details = el('details', 'oih-test-result');
            const pieces = [`#${test.id} ${statusLabel(test.status)}`];
            if (test.score !== null) {
                pieces.push(`${test.score}${test.maxScore === null ? '' : `/${test.maxScore}`} 分`);
            }
            if (test.timeMs !== null) {
                pieces.push(`${test.timeMs} ms`);
            }
            if (test.memoryKb !== null) {
                pieces.push(`${test.memoryKb} KB`);
            }
            details.appendChild(el('summary', '', pieces.join(' · ')));
            const body = el('div', 'oih-test-result-body');
            if (test.message) {
                body.appendChild(el('div', '', test.message));
            }
            if (test.stderr) {
                body.appendChild(el('div', 'oih-kv-key', 'stderr'));
                body.appendChild(el('pre', 'oih-pre', sliceText(test.stderr, 1200)));
            }
            body.appendChild(el('div', 'oih-kv-key', '实际输出'));
            body.appendChild(el('pre', 'oih-pre', sliceText(test.actual || '(空)', 1200)));
            body.appendChild(el('div', 'oih-kv-key', '期望输出'));
            body.appendChild(el('pre', 'oih-pre', sliceText(test.expected || '(空)', 1200)));
            details.appendChild(body);
            box.appendChild(details);
        }
    }

    function readJudgeCode() {
        showMessage('', false);
        const code = readCodeIntoState();
        if (code === null) {
            showMessage(state.codeError || '读取代码失败.', true);
            return null;
        }
        if (!String(code).trim()) {
            showMessage('编辑器代码为空, 请先写入代码后重试.', true);
            return null;
        }
        return code;
    }

    async function judgeWith(payload, successMessage) {
        if (state.busy) {
            return;
        }
        const code = readJudgeCode();
        if (code === null) {
            return;
        }
        setBusy(true);
        const response = await send(Object.assign({ type: 'panel:judge', source: code }, payload));
        setBusy(false);
        if (!response.ok) {
            state.judge = null;
            state.judgeError = response.error || '评测失败.';
            renderJudge();
            showMessage(state.judgeError, true);
            return;
        }
        state.judge = response.result;
        state.judgeError = '';
        renderJudge();
        showMessage(successMessage, false);
    }

    async function runJudge() {
        await judgeWith({}, '评测完成.');
    }

    async function runFirstTest() {
        const test = state.tests.find((item) => item.enabled && item.source === 'custom')
            || state.tests.find((item) => item.enabled);
        if (!test) {
            showMessage('没有可运行的测试点, 已改用桌面题目目录评测.', false);
            await judgeWith({}, '评测完成.');
            return;
        }
        await judgeWith(
            { input: test.input, expected: test.output },
            `已按「${test.label}」运行, 结果见下方.`
        );
    }

    async function queryResult() {
        if (state.busy) {
            return;
        }
        const response = await send({ type: 'getLastResult' });
        if (!response.ok) {
            state.query = null;
            state.queryError = response.error || '查询结果失败.';
            renderJudge();
            showMessage(state.queryError, true);
            return;
        }
        if (!response.result) {
            state.query = null;
            state.queryError = '暂无结果记录; 在线评测结果以桌面程序即时返回为准.';
            renderJudge();
            showMessage(state.queryError, true);
            return;
        }
        state.query = response.result;
        state.queryError = '';
        renderJudge();
        showMessage('已刷新最近一次记录.', false);
    }

    async function openSubmitTab(url) {
        if (!url) {
            return { ok: false, error: '提交地址为空.' };
        }
        if (url === location.href) {
            return { ok: false, error: '当前页面就是提交页, 但无法自动写入代码, 请手动粘贴后提交.' };
        }
        const response = await send({ type: 'panel:openTab', url });
        if (response.ok) {
            return { ok: true };
        }
        try {
            const opened = window.open(url, '_blank', 'noopener');
            if (opened) {
                return { ok: true };
            }
        } catch (error) {
            // 后台打开失败时再尝试前台打开, 两者都失败才提示
        }
        return { ok: false, error: response.error || '打开提交页失败, 请手动复制链接打开.' };
    }

    async function submit() {
        if (state.busy) {
            return;
        }
        showMessage('', false);
        const code = readCodeIntoState();
        setBusy(true);
        const response = await send({
            type: 'panel:submit',
            url: location.href,
            html: document.documentElement.outerHTML
        });
        const adapter = currentAdapter();
        const registry = adapters();
        let wrote = false;
        let writeError = '';
        if (adapter && code !== null) {
            const result = adapter.setCode(code, document);
            wrote = result.ok;
            writeError = result.error || '';
        } else if (!adapter) {
            writeError = state.codeError || '当前页面没有可写入的编辑器.';
        }
        if (response.ok && response.canAutoSubmit && wrote) {
            const submitted = registry
                ? registry.triggerSubmit(document)
                : { ok: false, error: '适配器未加载.' };
            setBusy(false);
            if (submitted.ok) {
                showMessage('已把代码写回编辑器并提交, 请稍后在站点查看结果.', false);
                return;
            }
            const opened = await openSubmitTab(response.url);
            const message = opened.ok
                ? `自动提交失败: ${submitted.error}; 已在新标签打开提交页, 请手动提交.`
                : `自动提交失败: ${submitted.error}; 打开提交页失败: ${opened.error}`;
            showMessage(message, true);
            return;
        }
        setBusy(false);
        let target = response.ok ? response.url : '';
        if (!target && state.problem && state.problem.submitUrl) {
            target = state.problem.submitUrl;
        }
        const reasons = [];
        if (!response.ok && response.error) {
            reasons.push(response.error);
        }
        if (!wrote) {
            reasons.push(writeError ? `未能写回编辑器: ${writeError}` : '未能写回编辑器: 当前页面没有可写入的编辑器.');
        }
        if (!target) {
            reasons.push('当前站点暂不支持自动提交, 也未找到提交页地址, 请手动在站点提交.');
            showMessage(reasons.join(', '), true);
            return;
        }
        const opened = await openSubmitTab(target);
        if (!opened.ok) {
            reasons.push(opened.error);
            showMessage(reasons.join(', '), true);
            return;
        }
        reasons.push(wrote
            ? '已把代码写回编辑器, 并打开提交页, 请确认后点击提交.'
            : '已打开提交页, 请粘贴代码后提交.');
        showMessage(reasons.join(', '), !wrote);
    }

    function mount() {
        if (state.mounted || document.getElementById(HOST_ID)) {
            return;
        }
        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;';
        const shadow = host.attachShadow({ mode: 'open' });
        buildUi(shadow);
        injectStyle(shadow);
        document.documentElement.appendChild(host);
        state.mounted = true;
        const adapter = currentAdapter();
        if (adapter) {
            setBadge(adapter.name, true);
        }
    }

    async function shouldMount() {
        const registry = adapters();
        if (!registry) {
            return false;
        }
        const byUrl = registry.byUrl(location.href);
        if (byUrl && byUrl.id !== 'generic') {
            return true;
        }
        if (registry.resolve(location.href, document)) {
            return true;
        }
        if (typeof OIHRules === 'undefined') {
            return false;
        }
        const rulesResponse = await send({ type: 'getRulesForUrl', url: location.href });
        if (!rulesResponse.ok || !rulesResponse.rules || !rulesResponse.rules.length) {
            return false;
        }
        const domFeatures = {};
        for (const rule of rulesResponse.rules) {
            domFeatures[rule.id] = OIHRules.probeFeatures(rule, document);
        }
        const matched = await send({
            type: 'identify',
            url: location.href,
            domFeatures,
            title: document.title
        });
        return Boolean(matched.ok && matched.pageType === 'problem');
    }

    async function init() {
        try {
            if (document.getElementById(HOST_ID)) {
                return;
            }
            if (await shouldMount()) {
                mount();
            }
        } catch (error) {
            console.warn('[OI Helper] 面板初始化失败:', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
