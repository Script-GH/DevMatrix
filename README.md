# DevPulse

**DevPulse** is an AI-powered environment diagnostician designed to help developers ensure their systems are correctly configured for their projects. It scans your local workspace, detects the required tech stack, probes your system for installed tools/runtimes, and uses AI to provide helpful explanations and fix commands for any discrepancies found.

## Features

- 🔍 **Dynamic Stack Detection**: Automatically parses `package.json`, `pyproject.toml`, and other config files to determine requirements.
- 🛠️ **Deep System Probing**: Checks for binary versions, version managers (NVM, etc.), and environment variables.
- 📊 **Health Score**: Generates a weighted health score (0-100) based on the severity of missing or misconfigured tools.
- 🤖 **AI-Powered Advisor**: Integrates with Google Gemini to provide context-aware explanations and specific shell commands to fix environment issues.
- 🖥️ **Premium Terminal UI**: Built with [Ink](https://github.com/vadimdemedes/ink) for a rich, interactive CLI experience.

## Project Structure

This is a monorepo managed with npm workspaces:

- `packages/cli`: The main command-line tool.
- `shared`: Common type definitions used across the project.

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm

### Installation

1. Clone the repository.
2. Install dependencies from the root:
   ```bash
   npm install
   ```

### Configuration (Optional)

To enable AI-powered fixes, you'll need a Google Gemini API Key:
1. Get an API key from [Google AI Studio](https://aistudio.google.com/).
2. Set it in your environment:
   ```powershell
   $env:GEMINI_API_KEY="your_api_key_here"
   ```

### Running the CLI

You can run the CLI in development mode using `tsx`:

```bash
# From the root directory
npm run dev --prefix packages/cli scan
```

Or build and run:

```bash
# Build the project
npm run build --prefix packages/cli

# Run the built version
node packages/cli/dist/index.js scan
```

## How it Works

1. **Scanner**: Detects what your project needs (e.g., Node version, Docker, specific env vars).
2. **Prober**: Checks what you actually have installed.
3. **Diff Engine**: Compares requirements vs. actual state and calculates a health score.
4. **AI Advisor**: Sends failures to Gemini to get human-readable fixes.
5. **Renderer**: Displays a beautiful dashboard in your terminal.
