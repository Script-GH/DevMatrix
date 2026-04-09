import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class DevPulseSidebarProvider implements vscode.WebviewViewProvider {
  _view?: vscode.WebviewView;
  private _outputChannel: vscode.LogOutputChannel;
  private _effectiveRoot?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._outputChannel = vscode.window.createOutputChannel('DevPulse', { log: true });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    this._outputChannel.info('Webview resolved');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case 'ready':
          this._outputChannel.info('Webview ready, triggering initial scan');
          this.triggerScan();
          break;
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

    webviewView.webview.html = this._getHtmlForWebview();
  }

  private findConfig(rootPath: string): string | undefined {
    // 1. Check Root
    const rootConfig = path.join(rootPath, '.dmxrc');
    if (fs.existsSync(rootConfig)) return rootConfig;

    // 2. Check subdirectories (1 level deep)
    try {
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const subConfig = path.join(rootPath, entry.name, '.dmxrc');
                if (fs.existsSync(subConfig)) return subConfig;
            }
        }
    } catch (e) {}

    return undefined;
  }

  private resolveCliPath(): string | undefined {
    const config = vscode.workspace.getConfiguration('devpulse');
    const manualPath = config.get<string>('cliPath');
    if (manualPath && fs.existsSync(manualPath)) {
        return manualPath;
    }

    const devPath = path.join(this._extensionUri.fsPath, '..', 'cli', 'dist', 'index.js');
    if (fs.existsSync(devPath)) {
        return devPath;
    }

    const bundledPath = path.join(this._extensionUri.fsPath, 'dist', 'cli', 'index.js');
    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }

    return undefined;
  }

  public async triggerScan() {
    if (!this._view) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('DevPulse: No workspace folder open');
        return;
    }
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    this._outputChannel.info(`Starting scan in: ${rootPath}`);

    // PHASE 1: Instant Metadata Load
    let projectInfo = null;
    this._effectiveRoot = rootPath;

    try {
        const configPath = this.findConfig(rootPath);
        if (configPath) {
            this._effectiveRoot = path.dirname(configPath);
            const content = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);
            if (config.projectId) {
                projectInfo = {
                    initialized: true,
                    projectId: config.projectId,
                    officialState: config.metadata,
                    team: config.team || []
                };
                this._outputChannel.info(`Found metadata at: ${configPath}`);
                this._view.webview.postMessage({ type: 'scanComplete', report: null, projectInfo });
            }
        } else {
            this._outputChannel.warn(`No .dmxrc found in ${rootPath} or subfolders`);
        }
    } catch (e) {
        this._outputChannel.warn(`Failed to read config: ${e}`);
    }

    this._view.webview.postMessage({ type: 'scanStarted', hasMetadata: !!projectInfo });

    const cliEntry = this.resolveCliPath();
    if (!cliEntry) {
        this._view?.webview.postMessage({ type: 'scanError', error: 'CLI not found', showSettings: true });
        return;
    }

    const runCli = (cmd: string): Promise<string> => {
        return new Promise((resolve) => {
            exec(`node "${cliEntry}" ${cmd} --json`, { cwd: this._effectiveRoot, timeout: 60000 }, (error, stdout) => {
                resolve(stdout || '');
            });
        });
    };

    try {
        // PHASE 2: Live Health Scan & Background Metadata Refresh
        const [scanResult] = await Promise.allSettled([
            runCli('scan'),
            runCli('project-info')
        ]);

        let report = null;
        if (scanResult.status === 'fulfilled') {
            try {
                const stdout = scanResult.value;
                const jsonStart = stdout.indexOf('{');
                const jsonEnd = stdout.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    report = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1));
                }
            } catch (e) {}
        }

        if (report) {
            this._view?.webview.postMessage({ type: 'scanComplete', report, projectInfo });
            this._outputChannel.info('Scan complete');
        } else if (projectInfo) {
            // If scan failed but we have metadata, stay on metadata view
            this._view?.webview.postMessage({ type: 'scanComplete', report: null, projectInfo });
        } else {
            this._view?.webview.postMessage({ type: 'scanError', error: 'Scan failed' });
        }
    } catch (err: any) {
        this._view?.webview.postMessage({ type: 'scanError', error: err.message });
    }
  }

  public triggerAdvice() {
    if (!this._view) return;
    const workingDir = this._effectiveRoot || vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workingDir) return;
    
    this._view.webview.postMessage({ type: 'adviceStarted' });

    const cliEntry = this.resolveCliPath();
    if (!cliEntry) return;

    exec(`node "${cliEntry}" advice --raw`, { cwd: workingDir }, (error, stdout) => {
        this._view?.webview.postMessage({ type: 'adviceComplete', advice: stdout.trim() || 'No advice returned.' });
    });
  }

  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DMX Pulse</title>
    <style>
        :root {
            --bg-base: #0a0a0a;
            --bg-card: #141414;
            --fg-base: #ededed;
            --fg-dim: #9ca3af;
            --accent-primary: #3b82f6;
            --accent-success: #10b981;
            --accent-warning: #fbbf24;
            --accent-error: #ef4444;
            --border-muted: rgba(255, 255, 255, 0.08);
            --glass: rgba(255, 255, 255, 0.03);
        }

        body {
            font-family: system-ui, -apple-system, sans-serif;
            padding: 0; margin: 0;
            color: var(--fg-base);
            background-color: var(--bg-base);
            line-height: 1.5;
        }

        .layout { padding: 16px; display: flex; flex-direction: column; gap: 24px; }
        
        .project-badge {
            background: linear-gradient(135deg, #1e3a8a 0%, #1e1b4b 100%);
            padding: 12px 16px; border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .project-id { font-size: 10px; font-weight: 700; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }
        .project-name { font-size: 17px; font-weight: 700; margin-top: 4px; color: #fff; }

        .card {
            background: var(--bg-card); border: 1px solid var(--border-muted);
            border-radius: 16px; padding: 20px;
            background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%);
        }

        .gauge-section { display: flex; flex-direction: column; align-items: center; gap: 12px; }
        .gauge-container { width: 140px; height: 140px; position: relative; }
        .circular-chart { display: block; }
        .circle-bg { fill: none; stroke: rgba(255,255,255,0.03); stroke-width: 3.5; }
        .circle { 
            fill: none; stroke-width: 3.5; stroke-linecap: round; 
            transition: stroke-dasharray 1s ease;
        }
        .circle.good { stroke: var(--accent-success); }
        .circle.warning { stroke: var(--accent-warning); }
        .circle.critical { stroke: var(--accent-error); }
        .circle.dimmed { stroke: rgba(255,255,255,0.1); }
        
        .percentage { 
            fill: #fff; font-size: 8px; font-weight: 800; 
            text-anchor: middle; dominant-baseline: middle;
        }
        .score-label { font-size: 13px; font-weight: 600; color: var(--fg-dim); }

        h3 { 
            font-size: 11px; font-weight: 800; text-transform: uppercase; 
            letter-spacing: 0.1em; color: var(--fg-dim); 
            margin: 0 0 16px 0; display: flex; align-items: center; gap: 10px; 
        }
        h3::after { content: ''; flex: 1; height: 1px; background: var(--border-muted); }

        .team-list { display: flex; flex-direction: column; gap: 12px; }
        .team-member {
            display: flex; align-items: center; gap: 14px;
            padding: 10px 12px; border-radius: 10px;
            background: var(--glass);
        }
        .avatar {
            width: 36px; height: 36px; border-radius: 50%;
            background: #222; display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 700; color: var(--accent-primary);
            border: 1px solid rgba(255,255,255,0.1);
        }
        .member-info { flex: 1; display: flex; flex-direction: column; }
        .member-name { font-size: 14px; font-weight: 600; color: #fff; }
        .member-status { font-size: 11px; color: var(--fg-dim); }
        .presence-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-success); box-shadow: 0 0 10px var(--accent-success); }

        .check-item { 
            display: flex; gap: 14px; padding: 14px; 
            background: var(--glass); border-radius: 12px; 
            border: 1px solid var(--border-muted); margin-bottom: 12px;
        }
        .icon { width: 20px; height: 20px; flex-shrink: 0; }
        .icon-passed { color: var(--accent-success); }
        .icon-warning { color: var(--accent-warning); }
        .icon-critical { color: var(--accent-error); }
        
        .check-content { flex: 1; }
        .check-title { font-size: 14px; font-weight: 600; color: #fff; }
        .check-meta { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }

        .ai-box {
            margin-top: 12px; padding: 12px;
            background: rgba(59, 130, 246, 0.08);
            border-left: 3px solid var(--accent-primary);
            border-radius: 6px; font-size: 12px;
        }
        .ai-label { font-weight: 700; color: var(--accent-primary); margin-bottom: 8px; }
        .code-block {
            background: #000; padding: 10px; border-radius: 6px;
            font-family: monospace; font-size: 11px;
            margin-top: 10px; border: 1px solid rgba(255,255,255,0.1);
            display: flex; align-items: center; justify-content: space-between;
        }
        .copy-btn { 
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
            color: var(--fg-base); cursor: pointer; padding: 4px 8px; font-size: 10px; 
            border-radius: 4px;
        }

        .button-group { display: flex; gap: 10px; width: 100%; margin-top: 16px; }
        .btn {
            flex: 1; padding: 10px 16px; border-radius: 8px;
            font-size: 13px; font-weight: 700; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            border: 1px solid transparent;
        }
        .btn-primary { background: var(--accent-primary); color: #fff; }
        .btn-ghost { background: var(--glass); border-color: var(--border-muted); color: var(--fg-base); }

        .loader-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 20px; color: var(--fg-dim); }
        .spinner { 
            width: 32px; height: 32px; border: 3px solid rgba(255,255,255,0.05); 
            border-top-color: var(--accent-primary); border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Advice Modal Styles */
        .overlay {
            position: fixed; inset: 0; background: rgba(0,0,0,0.85);
            backdrop-filter: blur(8px); display: none;
            flex-direction: column; padding: 24px; z-index: 1000;
            animation: fadeIn 0.3s ease;
        }
        .overlay.active { display: flex; }
        .overlay-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .overlay-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
        .overlay-body { 
            flex: 1; overflow-y: auto; padding: 16px; 
            background: rgba(255,255,255,0.03); border-radius: 12px;
            font-size: 14px; white-space: pre-wrap; font-family: 'Inter', sans-serif;
            border: 1px solid var(--border-muted); line-height: 1.6;
        }
        .close-btn { background: var(--glass); border: 1px solid var(--border-muted); color: #fff; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    </style>
</head>
<body>
    <div id="content">
        <div class="loader-wrap">
            <div class="spinner"></div>
            <span>Syncing Pulse...</span>
        </div>
    </div>
    <div id="advice-overlay" class="overlay">
        <div class="overlay-header">
            <div class="overlay-title">✨ AI Project Advice</div>
            <button class="close-btn" onclick="closeAdvice()">Close</button>
        </div>
        <div id="advice-content" class="overlay-body"></div>
    </div>
    <div style="position: fixed; bottom: 8px; right: 8px; font-size: 9px; opacity: 0.2; pointer-events: none;">v2.2</div>
    <script>
        const vscode = acquireVsCodeApi();
        function getIcon(passed, severity) {
            const cls = passed ? 'icon-passed' : (severity === 'critical' ? 'icon-critical' : 'icon-warning');
            const path = passed ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12';
            return \`<svg class="icon \${cls}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="\${path}"></path></svg>\`;
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            console.log('Received message:', message.type);
            
            if (message.type === 'scanStarted') {
                const content = document.getElementById('content');
                if (!message.hasMetadata && !content.querySelector('.layout')) {
                    content.innerHTML = '<div class="loader-wrap"><div class="spinner"></div><span>Scanning Environment...</span></div>';
                }
            } else if (message.type === 'scanComplete') {
                renderDashboard(message.report, message.projectInfo);
            } else if (message.type === 'adviceStarted') {
                showAdvice('Generating AI insights for your architecture...');
            } else if (message.type === 'adviceComplete') {
                showAdvice(message.advice);
            }
        });

        function showAdvice(text) {
            document.getElementById('advice-content').innerText = text;
            document.getElementById('advice-overlay').classList.add('active');
        }

        function closeAdvice() {
            document.getElementById('advice-overlay').classList.remove('active');
        }

        function renderDashboard(report, project) {
            const hasReport = !!report;
            const score = hasReport ? report.score : 0;
            const dashArray = \`\${(score / 100) * 100}, 100\`;
            const colorClass = hasReport ? (score >= 80 ? 'good' : score >= 50 ? 'warning' : 'critical') : 'dimmed';

            let html = '<div class="layout">';
            if (project && project.projectId) {
                html += \`<div class="project-badge"><div class="project-id">Connected Project</div><div class="project-name">\${project.projectId}</div></div>\`;
            }

            html += \`<div class="card gauge-section">
                <div class="gauge-container">
                    <svg viewBox="0 0 36 36" class="circular-chart">
                        <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        <path class="circle \${colorClass}" stroke-dasharray="\${dashArray}" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
                        <text x="18" y="20.35" class="percentage">\${hasReport ? score + '%' : '...'}</text>
                    </svg>
                </div>
                <div class="score-label">\${hasReport ? 'Environment Health' : 'Scanning Deep Health...'}</div>
                <div class="button-group">
                    <button class="btn btn-primary" onclick="vscode.postMessage({type:'scan'})">Rescan</button>
                    <button class="btn btn-ghost" onclick="vscode.postMessage({type:'onAdvice'})">Ask AI</button>
                </div>
            </div>\`;

            if (project && project.team) {
                html += '<div><h3>Team Pulse</h3><div class="team-list">';
                project.team.forEach(dev => {
                    const initials = dev.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                    html += \`<div class="team-member">
                        <div class="avatar">\${initials}</div>
                        <div class="member-info"><span class="member-name">\${dev.name}</span><span class="member-status">\${dev.lastActive || 'Online'}</span></div>
                        <div class="presence-pulse"></div>
                    </div>\`;
                });
                html += '</div></div>';
            }

            if (hasReport) {
                html += '<div><h3>Diagnostics</h3>';
                report.checks.forEach(c => {
                    let aiBox = '';
                    if (!c.passed && c.fixCommand) {
                        aiBox = \`<div class="ai-box">
                            <div class="ai-label">✨ Fix Strategy</div>
                            <div class="code-block"><code>\${c.fixCommand}</code></div>
                        </div>\`;
                    }
                    html += \`<div class="check-item">
                        \${getIcon(c.passed, c.severity)}
                        <div class="check-content">
                            <div class="check-title">\${c.name}</div>
                            <div class="check-meta">\${c.found || 'Missing'}</div>
                            \${aiBox}
                        </div>
                    </div>\`;
                });
                html += '</div>';
            }
            html += '</div>';
            document.getElementById('content').innerHTML = html;
        }
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
  }
}
