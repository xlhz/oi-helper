import * as vscode from 'vscode';

// 把改动前后的文本按行做 LCS 差异, 供预览与输出面板使用
export function lineDiff(before: string, after: string, maxLines = 80): string {
    const a = before.split(/\r?\n/);
    const b = after.split(/\r?\n/);
    if (a.length * b.length > 400000) {
        return `(文件较大, 省略逐行对比; 行数 ${a.length} -> ${b.length})`;
    }
    const dp: number[][] = [];
    for (let i = 0; i <= a.length; i += 1) {
        dp.push(new Array<number>(b.length + 1).fill(0));
    }
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const lines: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            i += 1;
            j += 1;
        } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
            lines.push(`+ ${j + 1}: ${b[j]}`);
            j += 1;
        } else {
            lines.push(`- ${i + 1}: ${a[i]}`);
            i += 1;
        }
        if (lines.length >= maxLines) {
            lines.push('... 预览已截断, 完整内容见输出面板');
            break;
        }
    }
    return lines.length > 0 ? lines.join('\n') : '(无变化)';
}

// 先写输出面板再弹确认框, 未确认时不落盘
export async function confirmPreview(
    output: vscode.OutputChannel,
    title: string,
    preview: string,
    detail?: string
): Promise<boolean> {
    output.appendLine(`[预览] ${title}`);
    for (const line of preview.split(/\r?\n/)) {
        output.appendLine(line);
    }
    output.show(true);
    const compact = preview.length > 3000 ? `${preview.slice(0, 3000)}\n... (完整内容见输出面板 OI Helper)` : preview;
    const text = detail ? `${detail}\n\n${compact}` : compact;
    const action = await vscode.window.showInformationMessage(title, { modal: true, detail: text }, '应用修改', '取消');
    return action === '应用修改';
}
