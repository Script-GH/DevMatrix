import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class DevPulseSidebarProvider implements vscode.WebviewViewProvider {
  _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case 'scan':
          this.triggerScan();
          break;
        case 'onAdvice':
          this.triggerAdvice();
          break;
        case 'onInfo':
          vscode.window.showInformationMessage(data.value);
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'devpulse.cliPath');
          break;
      }
    });
    
    // Automatically scan on load if a workspace is open
    setTimeout(() => {
        if (vscode.workspace.workspaceFolders) {
            this.triggerScan();
        }
    }, 1000);
  }

  private resolveCliPath(): string | undefined {
    // 1. Check user setting
    const config = vscode.workspace.getConfiguration('devpulse');
    const manualPath = config.get<string>('cliPath');
    if (manualPath && fs.existsSync(manualPath)) {
        return manualPath;
    }

    // 2. Check development monorepo path
    const devPath = path.join(this._extensionUri.fsPath, '..', 'cli', 'dist', 'index.js');
    if (fs.existsSync(devPath)) {
        return devPath;
    }

    // 3. Check bundled path (hypothetical structure for published extension)
    const bundledPath = path.join(this._extensionUri.fsPath, 'dist', 'cli', 'index.js');
    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }

    return undefined;
  }

  public triggerScan() {
    if (!this._view) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('DevPulse: No workspace folder open');
        return;
    }
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    this._view.webview.postMessage({ type: 'scanStarted' });

    const cliEntry = this.resolveCliPath();
    
    if (!cliEntry) {
        const errorMsg = `DevPulse CLI not found. Please ensure it's built or set the path in settings.`;
        vscode.window.showErrorMessage('DevPulse: CLI module missing.');
        this._view?.webview.postMessage({ type: 'scanError', error: errorMsg, showSettings: true });
        return;
    }

    // Try both node paths (windows / linux)
    exec(`node "${cliEntry}" scan --json`, { cwd: rootPath }, (error, stdout, stderr) => {
        if (error) {
            console.error('Scan error:', error);
            vscode.window.showErrorMessage('DevPulse: Scan failed to run');
            this._view?.webview.postMessage({ type: 'scanError', error: error.message });
            return;
        }
        
        try {
            // Find the JSON part in case there's extra output
            const jsonStart = stdout.indexOf('{');
            const jsonEnd = stdout.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1) {
                throw new Error('No JSON object found in output');
            }
            const rawJson = stdout.substring(jsonStart, jsonEnd + 1);
            const report = JSON.parse(rawJson);
            this._view?.webview.postMessage({ type: 'scanComplete', report });
        } catch (e) {
            console.error('Failed to parse scan output', e);
            console.log('Output was:', stdout);
            vscode.window.showErrorMessage('DevPulse: Failed to parse diagnostics from CLI');
            this._view?.webview.postMessage({ type: 'scanError', error: 'Invalid JSON' });
        }
    });
  }

  public triggerAdvice() {
    if (!this._view) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('DevPulse: No workspace folder open');
        return;
    }
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    this._view.webview.postMessage({ type: 'adviceStarted' });

    const cliEntry = this.resolveCliPath();
    
    if (!cliEntry) {
        vscode.window.showErrorMessage('DevPulse: CLI module missing.');
        this._view?.webview.postMessage({ type: 'scanError', error: 'CLI module missing.', showSettings: true });
        return;
    }

    // Call dmx advice --raw (we'll implement --raw in CLI next)
    exec(`node "${cliEntry}" advice --raw`, { cwd: rootPath }, (error, stdout, stderr) => {
        if (error) {
           console.error('Advice error:', error);
           // Not treating as fatal because it still might yield something, or API key missing
        }
        this._view?.webview.postMessage({ type: 'adviceComplete', advice: stdout.trim() || 'No advice returned.' });
    });
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DevPulse Dashboard</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 16px;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.5;
        }
        .container { display: flex; flex-direction: column; gap: 20px; }
        .gauge-container { display: flex; align-items: center; justify-content: center; padding: 20px 0; }
        .circular-chart { display: block; margin: 0 auto; max-width: 140px; max-height: 140px; }
        .circle-bg { fill: none; stroke: var(--vscode-editorSuggestWidget-background); stroke-width: 2.5; }
        .circle { fill: none; stroke-width: 2.5; stroke-linecap: round; transition: stroke-dasharray 1s ease-out; }
        .circle.good { stroke: var(--vscode-testing-iconPassed); }
        .circle.warning { stroke: var(--vscode-list-warningForeground); }
        .circle.critical { stroke: var(--vscode-testing-iconFailed); }
        .percentage { fill: var(--vscode-editor-foreground); font-family: inherit; font-size: 8px; font-weight: 600; text-anchor: middle; }
        h3 { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 0 0 10px 0; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
        .check-item { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; }
        .icon-svg { width: 14px; height: 14px; }
        .icon-passed { color: var(--vscode-testing-iconPassed); }
        .icon-warning { color: var(--vscode-list-warningForeground); }
        .icon-critical { color: var(--vscode-testing-iconFailed); }
        .check-details { flex: 1; display: flex; flex-direction: column; }
        .check-name { font-weight: 500; }
        .check-found { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .action-button { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 12px; background-color: transparent; color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, var(--vscode-focusBorder)); border-radius: 2px; cursor: pointer; font-size: 12px; width: 100%; margin-top: 5px; }
        .action-button:hover { background-color: var(--vscode-button-hoverBackground); }
        .action-button.primary { background-color: var(--vscode-button-background); border: none; }
        .button-group { display: flex; gap: 10px; margin-top: 10px; }
        .loader { text-align: center; color: var(--vscode-descriptionForeground); margin-top: 20px; }
        .ai-fix { margin-top: 8px; padding: 10px; background-color: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); font-size: 12px; }
        .ai-fix-title { font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
        .ai-fix-command { background-color: var(--vscode-textCodeBlock-background); padding: 4px 8px; border-radius: 4px; font-family: monospace; display: flex; justify-content: space-between; align-items: center; margin-top: 8px; border: 1px solid var(--vscode-widget-border); }
        .ai-fix-command code { word-break: break-all; }
        .copy-btn { background: transparent; border: 1px solid var(--vscode-button-border); color: var(--vscode-button-foreground); cursor: pointer; padding: 2px 6px; border-radius: 2px; font-size: 10px; }
        .copy-btn:hover { background-color: var(--vscode-button-hoverBackground); }
        .advice-box { margin-top: 20px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; font-size: 12px; white-space: pre-wrap; }
    </style>
</head>
<body>
    <div id="content"><div class="loader">Loading DevPulse...</div></div>
    <script>
        const vscode = acquireVsCodeApi();
        
        function getIcon(passed, severity) {
            if (passed) return '<svg class="icon-svg icon-passed" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
            if (severity === 'critical') return '<svg class="icon-svg icon-critical" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
            return '<svg class="icon-svg icon-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'scanStarted') {
                document.getElementById('content').innerHTML = '<div class="loader">Scanning workspace...</div>';
            } else if (message.type === 'adviceStarted') {
                const oldContent = document.getElementById('content').innerHTML;
                document.getElementById('content').innerHTML = '<div class="loader">Gathering AI advice...</div>' + oldContent.replace(/<div class="loader">.*?<\\/div>/, '');
            } else if (message.type === 'scanError') {
                let html = '<div style="color:var(--vscode-errorForeground); margin-bottom: 20px;">Error: ' + message.error + '</div>';
                if (message.showSettings) {
                    html += '<button class="action-button primary" onclick="vscode.postMessage({type: \\'openSettings\\'})">Configure CLI Path</button>';
                }
                document.getElementById('content').innerHTML = html;
            } else if (message.type === 'scanComplete') {
                window.lastReport = message.report;
                renderReport(message.report);
            } else if (message.type === 'adviceComplete') {
                if (window.lastReport) {
                    renderReport(window.lastReport, message.advice);
                }
            }
        });

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                vscode.postMessage({type: 'onInfo', value: 'Fix command copied!'});
            });
        }

        function renderReport(report, adviceText = null) {
            const dashArray = ((report.score / 100) * 100) + ", 100";
            const circleClass = report.score >= 80 ? 'good' : report.score >= 50 ? 'warning' : 'critical';

            let html = '<div class="container">' +
                '<div class="gauge-container">' +
                '<svg viewBox="0 0 36 36" class="circular-chart">' +
                '<path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>' +
                '<path class="circle ' + circleClass + '" stroke-dasharray="' + dashArray + '" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>' +
                '<text x="18" y="20.35" class="percentage">' + report.score + '%</text>' +
                '</svg></div>' +
                '<div class="button-group">' +
                '<button class="action-button primary" onclick="vscode.postMessage({type: \\'scan\\'})">Rescan</button>' +
                '<button class="action-button" onclick="vscode.postMessage({type: \\'onAdvice\\'})">Ask AI</button>' +
                '</div>';

            if (adviceText) {
                html += '<div class="advice-box"><strong>Architectural Advice</strong><br><br>' + adviceText.replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</div>';
            }

            const sections = [
                { title: 'Runtimes & Tooling', items: report.checks.filter(c => ['runtime', 'package_manager', 'tool'].includes(c.category)) },
                { title: 'Environment Variables', items: report.checks.filter(c => c.category === 'env_var') },
                { title: 'Configuration', items: report.checks.filter(c => c.category === 'config') }
            ];

            sections.forEach(sec => {
                if (sec.items.length === 0) return;
                html += '<div><h3>' + sec.title + '</h3>';
                sec.items.forEach(c => {
                    const reqStr = c.required ? ' &middot; Req: ' + c.required : '';
                    const foundStr = c.found ? 'Found ' + c.found : 'Missing';
                    html += '<div class="check-item">' +
                        '<div class="icon-container">' + getIcon(c.passed, c.severity) + '</div>' +
                        '<div class="check-details">' +
                        '<span class="check-name">' + c.name + '</span>' +
                        '<span class="check-found">' + foundStr + reqStr + '</span>';
                    
                    if (!c.passed && c.fixCommand) {
                        const escapedCmd = c.fixCommand.replace(/'/g, "\\\\'");
                        html += '<div class="ai-fix">' +
                                '<div class="ai-fix-title">✨ AI Fix Recommendation</div>' +
                                '<div>' + (c.explanation || '') + '</div>' +
                                '<div class="ai-fix-command">' +
                                '<code>' + c.fixCommand + '</code>' +
                                '<button class="copy-btn" onclick="copyToClipboard(\\\'' + escapedCmd + '\\\')">Copy</button>' +
                                '</div>' +
                                '</div>';
                    } else if (!c.passed && c.explanation) {
                        html += '<div class="ai-fix"><div class="ai-fix-title">✨ AI Note</div><div>' + c.explanation + '</div></div>';
                    }

                    html += '</div></div>';
                });
                html += '</div>';
            });

            html += '</div>';
            document.getElementById('content').innerHTML = html;
        }
    </script>
</body>
</html>`;
  }
}
