import * as vscode from 'vscode';
import { DevPulseSidebarProvider } from './DevPulseSidebarProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('DevPulse extension is now active!');

  const sidebarProvider = new DevPulseSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "devpulse-sidebar.view",
      sidebarProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('devpulse.scan', () => {
      sidebarProvider.triggerScan();
    })
  );
}

export function deactivate() { }
