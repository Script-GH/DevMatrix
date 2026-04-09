import React, { useEffect, useState } from 'react';
import { Box, Text, render, useInput, useApp } from 'ink';
import { HealthReport, CheckResult } from '@devpulse/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

type UIPhase =
  | 'scanning'   // initial load, data not yet ready
  | 'ai-loading' // checks done, waiting for AI fixes
  | 'ready'      // fully loaded, awaiting user input
  | 'exiting';   // user pressed a key, tearing down

export type UserAction = 'fix' | 'advice' | 'quit';

// ─── Design tokens ────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 85) return 'green';
  if (score >= 55) return 'yellow';
  return 'red';
}

function scoreLabel(score: number): string {
  if (score === 100) return 'Perfect';
  if (score >= 85)   return 'Ready to code';
  if (score >= 55)   return 'Needs attention';
  return 'Critical issues';
}

function severityColor(check: CheckResult): string {
  if (check.passed)                       return 'green';
  if (check.severity === 'critical')      return 'red';
  return 'yellow';
}

function severityIcon(check: CheckResult): string {
  if (check.passed)                       return '✓';
  if (check.severity === 'critical')      return '✗';
  return '!';
}

function statusText(check: CheckResult): string {
  if (check.passed) return 'ok';
  if (!check.found) return 'missing';
  if (check.statusLabel) return check.statusLabel.toLowerCase();
  return 'fail';
}

// ─── Divider ──────────────────────────────────────────────────────────────────

const Divider = ({ label }: { label: string }) => (
  <Box marginTop={1} marginBottom={1}>
    <Text dimColor>{'─'.repeat(3)} </Text>
    <Text bold color="white">{label}</Text>
    <Text dimColor> {'─'.repeat(40)}</Text>
  </Box>
);

// ─── Score bar ────────────────────────────────────────────────────────────────

const ScoreBar = ({ score, animated }: { score: number; animated: number }) => {
  const width = 40;
  const filled = Math.round((animated / 100) * width);
  const color = scoreColor(animated);

  return (
    <Box flexDirection="column">
      <Box gap={2} alignItems="center">
        {/* Numeric score — large but terminal-safe, no figlet dependency */}
        <Box width={10}>
          <Text color={color} bold>{String(animated).padStart(3)}</Text>
          <Text dimColor>/100</Text>
        </Box>
        {/* Bar */}
        <Box flexDirection="column">
          <Box>
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(width - filled)}</Text>
          </Box>
          <Box justifyContent="space-between" width={width}>
            <Text dimColor>0</Text>
            <Text color={color} bold>{scoreLabel(animated)}</Text>
            <Text dimColor>100</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

// ─── Check row ────────────────────────────────────────────────────────────────

const CheckRow = ({ check }: { check: CheckResult }) => {
  const color = severityColor(check);
  const icon  = severityIcon(check);
  const status = statusText(check);

  const statusColorMap: Record<string, string> = {
    ok: 'green', missing: 'red', outdated: 'red',
    'update available': 'yellow', mismatch: 'yellow', fail: 'red',
  };
  const statusColor = statusColorMap[status] ?? 'white';

  const detail = [
    check.found ? `found ${check.found}` : 'not found',
    check.required ? `required ${check.required}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <Box gap={1} marginBottom={0}>
      <Box width={2}>
        <Text color={color} bold>{icon}</Text>
      </Box>
      <Box width={22}>
        <Text bold>{check.name}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor>{detail}</Text>
      </Box>
      {/* Status badge — text-only, no backgroundColor for terminal compat */}
      <Box width={18} justifyContent="flex-end">
        <Text color={statusColor}>[{status}]</Text>
      </Box>
      {!check.passed && (
        <Box width={10} justifyContent="flex-end">
          <Text color="cyan">fix ↗</Text>
        </Box>
      )}
    </Box>
  );
};

// ─── AI diagnosis card ────────────────────────────────────────────────────────

const AICard = ({ check }: { check: CheckResult }) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="yellow"
    paddingX={2}
    paddingY={1}
    marginBottom={1}
  >
    <Text color="yellow" bold>AI · {check.name}</Text>
    {check.explanation && (
      <Box marginTop={1}>
        <Text wrap="wrap">{check.explanation}</Text>
      </Box>
    )}
    {check.fixCommand && (
      <Box marginTop={1} gap={1}>
        <Text dimColor>$</Text>
        <Text color="green" bold>{check.fixCommand}</Text>
        {check.risk && (
          <Text color={check.risk === 'safe' ? 'green' : check.risk === 'moderate' ? 'yellow' : 'red'}>
            [{check.risk}]
          </Text>
        )}
      </Box>
    )}
  </Box>
);

// ─── Loading spinner (no external dep) ───────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const Spinner = ({ label }: { label: string }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);

  return (
    <Box gap={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      <Text dimColor>{label}</Text>
    </Box>
  );
};

// ─── Footer ───────────────────────────────────────────────────────────────────

const Footer = ({ phase }: { phase: UIPhase }) => {
  if (phase === 'scanning' || phase === 'ai-loading') {
    return (
      <Box marginTop={1}>
        <Spinner label={phase === 'scanning' ? 'Scanning environment...' : 'Fetching AI fixes...'} />
      </Box>
    );
  }

  if (phase === 'exiting') {
    return (
      <Box marginTop={1}>
        <Text color="green">Handing off to agent...</Text>
      </Box>
    );
  }

  // ready
  return (
    <Box marginTop={1} gap={3}>
      <Text color="green" bold>[F]</Text><Text> Fix all with agent</Text>
      <Text color="cyan"  bold>[A]</Text><Text> Get AI advice</Text>
      <Text dimColor      bold>[Q]</Text><Text dimColor> Quit</Text>
    </Box>
  );
};

// ─── Main dashboard ───────────────────────────────────────────────────────────

interface DashboardProps {
  report: HealthReport;
  phase: UIPhase;
  onAction: (action: UserAction) => void;
}

const Dashboard = ({ report, phase, onAction }: DashboardProps) => {
  const [animatedScore, setAnimatedScore] = useState(0);
  const { exit } = useApp();

  // Animate score counter
  useEffect(() => {
    const target = report.score;
    let current = animatedScore;

    // Fast-tick animation: 16ms per step, max 2pts per tick for large jumps
    const t = setInterval(() => {
      const step = Math.max(1, Math.ceil(Math.abs(target - current) / 12));
      if (current < target) {
        current = Math.min(target, current + step);
        setAnimatedScore(current);
      } else if (current > target) {
        current = Math.max(target, current - step);
        setAnimatedScore(current);
      } else {
        clearInterval(t);
      }
    }, 16);

    return () => clearInterval(t);
  }, [report.score]);

  // Keyboard handler — only active when ready
  useInput((input) => {
    if (phase !== 'ready') return;
    const key = input.toLowerCase();
    if (key === 'q') { onAction('quit'); exit(); }
    if (key === 'f') { onAction('fix'); }
    if (key === 'a') { onAction('advice'); }
  });

  const runtimeChecks = report.checks.filter(c =>
    ['runtime', 'package_manager', 'tool'].includes(c.category)
  );
  const envChecks = report.checks.filter(c => c.category === 'env_var');
  const aiChecks  = report.checks.filter(c => !c.passed && (c.explanation || c.fixCommand));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>

      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">DevPulse</Text>
        <Text dimColor> · {report.projectPath}</Text>
      </Box>

      {/* Score */}
      <Box marginBottom={1}>
        <ScoreBar score={report.score} animated={animatedScore} />
      </Box>

      {/* Runtimes */}
      {runtimeChecks.length > 0 && (
        <>
          <Divider label="Runtimes & tooling" />
          {runtimeChecks.map(c => <CheckRow key={c.id} check={c} />)}
        </>
      )}

      {/* Env vars */}
      {envChecks.length > 0 && (
        <>
          <Divider label="Environment variables" />
          {envChecks.map(c => <CheckRow key={c.id} check={c} />)}
        </>
      )}

      {/* AI diagnosis — only when data is available */}
      {aiChecks.length > 0 && (
        <>
          <Divider label="AI diagnosis" />
          {aiChecks.map(c => <AICard key={c.id} check={c} />)}
        </>
      )}

      {/* Footer */}
      <Footer phase={phase} />

    </Box>
  );
};

// ─── Render controller ────────────────────────────────────────────────────────

export interface RenderController {
  /** Resolves when the ink instance fully exits */
  waitUntilExit: () => Promise<void>;
  /** Push a new report snapshot (e.g. after AI fixes arrive) */
  updateReport: (report: HealthReport, phase: UIPhase) => void;
  /** The action the user chose — resolves only once user acts */
  actionPromise: Promise<UserAction>;
}

export function renderReport(
  initial: HealthReport,
  initialPhase: UIPhase = 'scanning',
): RenderController {
  // Single promise that resolves exactly once with the user's chosen action
  let resolveAction!: (action: UserAction) => void;
  const actionPromise = new Promise<UserAction>(res => { resolveAction = res; });

  // Mutable refs shared via closure — ink re-renders on prop changes via rerender()
  let currentReport = initial;
  let currentPhase  = initialPhase;

  // Track whether action has fired — guard against double-resolve
  let actionFired = false;
  const handleAction = (action: UserAction) => {
    if (actionFired) return;
    actionFired = true;
    // Update phase to 'exiting' so footer gives feedback before unmount
    currentPhase = 'exiting';
    instance.rerender(
      <Dashboard
        report={currentReport}
        phase={currentPhase}
        onAction={handleAction}
      />
    );
    // Small delay so user sees "Handing off..." before ink exits
    setTimeout(() => {
      resolveAction(action);
    }, 280);
  };

  const instance = render(
    <Dashboard
      report={currentReport}
      phase={currentPhase}
      onAction={handleAction}
    />
  );

  return {
    waitUntilExit: () => instance.waitUntilExit(),

    updateReport(report: HealthReport, phase: UIPhase) {
      currentReport = report;
      currentPhase  = phase;
      instance.rerender(
        <Dashboard
          report={report}
          phase={phase}
          onAction={handleAction}
        />
      );
    },

    actionPromise,
  };
}