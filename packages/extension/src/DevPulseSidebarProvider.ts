import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

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
        case 'onInfo':
          vscode.window.showInformationMessage(data.value);
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

  public triggerScan() {
    if (!this._view) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('DevPulse: No workspace folder open');
        return;
    }
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    this._view.webview.postMessage({ type: 'scanStarted' });

    // The CLI is located relative to the extension directory in the monorepo
    const cliEntry = path.join(this._extensionUri.fsPath, '..', 'cli', 'dist', 'index.js');
    
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
            const rawJson = stdout.substring(jsonStart);
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
            } else if (message.type === 'scanError') {
                document.getElementById('content').innerHTML = '<div style="color:var(--vscode-errorForeground)">Error during scan: ' + message.error + '</div>';
            } else if (message.type === 'scanComplete') {
                renderReport(message.report);
            }
        });

        function renderReport(report) {
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
                '<button class="action-button" onclick="vscode.postMessage({type: \\'onInfo\\', value: \\'AI Advisor coming soon...\\'})">Ask AI</button>' +
                '</div>';

            const sections = [
                { title: 'Runtimes & Tooling', items: report.checks.filter(c => ['runtime', 'package_manager', 'tool'].includes(c.category)) },
                { title: 'Environment Variables', items: report.checks.filter(c => c.category === 'env_var') },
                { title: 'Configuration', items: report.checks.filter(c => c.category === 'config') }
            ];

            sections.forEach(sec => {
                if (sec.items.length === 0) return;
                html += '<div><h3>' + sec.title + '</h3>';
                sec.items.forEach(c => {
                    const reqStr = c.required ? ' · Req: ' + c.required : '';
                    const foundStr = c.found ? 'Found ' + c.found : 'Missing';
                    html += '<div class="check-item">' +
                        '<div class="icon-container">' + getIcon(c.passed, c.severity) + '</div>' +
                        '<div class="check-details">' +
                        '<span class="check-name">' + c.name + '</span>' +
                        '<span class="check-found">' + foundStr + reqStr + '</span>' +
                        '</div></div>';
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
