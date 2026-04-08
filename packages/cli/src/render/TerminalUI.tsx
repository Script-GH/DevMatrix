import React, { useEffect, useState } from 'react';
import { Box, Text, render, Transform, useInput, useApp } from 'ink';
import gradient from 'gradient-string';
import figlet from 'figlet';
import { HealthReport, CheckResult } from '@devpulse/shared';

const STATUS_COLORS: Record<string, string> = {
  ok: 'green',
  missing: 'red',
  outdated: 'red',
  'update available': 'yellow',
  mismatch: 'yellow',
};

const StatusPill = ({ label }: { label: string }) => {
  const color = STATUS_COLORS[label.toLowerCase()] || 'white';
  return (
    <Box paddingX={1}>
      <Text color="black" backgroundColor={color}> {label.toLowerCase()} </Text>
    </Box>
  );
};

const HorizontalProgressBar = ({ score }: { score: number }) => {
  const width = 46;
  const filled = Math.round((score / 100) * width);
  const bar = '█'.repeat(filled);
  const background = '░'.repeat(width - filled);

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text dimColor>0</Text>
        <Text color="yellow" bold>Needs attention</Text>
        <Text dimColor>100</Text>
      </Box>
      <Box>
        <Text color="yellow">{bar}</Text>
        <Text dimColor>{background}</Text>
      </Box>
    </Box>
  );
};

const CheckRow = ({ check }: { check: CheckResult }) => {
  const icon = check.passed ? '✓' : check.severity === 'critical' ? 'X' : '!';
  const iconColor = check.passed ? 'green' : check.severity === 'critical' ? 'red' : 'yellow';

  return (
    <Box gap={2} marginBottom={0}>
      <Box width={2}>
        <Text color={iconColor} bold>{icon}</Text>
      </Box>
      <Box width={20}>
        <Text bold>{check.name}</Text>
      </Box>
      <Box flexGrow={1} minWidth={30}>
        <Text dimColor>
          {check.found ? `Found ${check.found}` : 'Not found'}
          {check.required ? ` · Required ${check.required}` : ''}
        </Text>
      </Box>
      <Box width={15} justifyContent="flex-end">
        {check.statusLabel && <StatusPill label={check.statusLabel} />}
      </Box>
      <Box width={12} justifyContent="flex-end">
        {!check.passed && <Text color="cyan" underline>Auto-fix ↗</Text>}
      </Box>
    </Box>
  );
};

const AICard = ({ check }: { check: CheckResult }) => (
  <Box
    flexDirection="column"
    borderStyle="single"
    borderColor="yellow"
    padding={1}
    marginY={1}
  >
    <Box marginBottom={1}>
      <Text color="yellow" bold>GEMINI · FIX ADVISOR</Text>
    </Box>
    <Text>{check.explanation}</Text>
    {check.fixCommand && (
      <Box marginTop={1} paddingX={1} borderStyle="bold" borderColor="dim">
        <Text color="green">$ {check.fixCommand}</Text>
      </Box>
    )}
  </Box>
);
const Footer = () => (
  <Box gap={2} marginTop={1}>
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>Press <Text bold color="yellow">f</Text> to Fix with Agent</Text>
    </Box>
    <Box borderStyle="round" borderColor="dim" paddingX={1}>
      <Text>Export report</Text>
    </Box>
  </Box>
);

const ReportDashboard = ({ initialReport, onFixRequest }: { initialReport: HealthReport, onFixRequest: () => void }) => {
  const [report, setReport] = useState(initialReport);
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'f') {
      onFixRequest();
      exit();
    }
  });

  const [animatedScore, setAnimatedScore] = useState(0);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const { exit } = useApp();

  useInput(async (input) => {
    if (input === 'q') {
      exit();
    }
    if (input === 'f') {
      setActiveAction('fix');
      await onFix?.();
      // Keep status for a moment then could reset or update report
    }
    if (input === 'a') {
      setActiveAction('advice');
      await onAdvice?.();
    }
  });

  useEffect(() => {
    let current = animatedScore;
    const target = report.score;
    const interval = setInterval(() => {
      if (current < target) {
        current += 1;
        setAnimatedScore(current);
      } else if (current > target) {
        current -= 1;
        setAnimatedScore(current);
      } else {
        clearInterval(interval);
      }
    }, 20);
    return () => clearInterval(interval);
  }, [report.score]);

  useEffect(() => {
    setReport(initialReport);
    setActiveAction(null); // Reset action on new report
  }, [initialReport]);

  const bigScore = figlet.textSync(animatedScore.toString(), { font: 'Standard' });

  return (
    <Box flexDirection="column" padding={2}>
      <Box gap={5} marginBottom={2} alignItems="center">
        <Box flexDirection="column" width={25}>
          <Text color="yellow" bold>{bigScore}</Text>
          <Text dimColor bold>  Health score</Text>
        </Box>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <HorizontalProgressBar score={animatedScore} />
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text dimColor bold>RUNTIMES & TOOLING</Text>
        </Box>
        {report.checks.filter(c => ['runtime', 'package_manager', 'tool'].includes(c.category)).map(c => (
          <CheckRow key={c.id} check={c} />
        ))}
      </Box>

      {/* Environment Variables */}
      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text dimColor bold>ENVIRONMENT VARIABLES</Text>
        </Box>
        {report.checks.filter(c => c.category === 'env_var').map(c => (
          <CheckRow key={c.id} check={c} />
        ))}
      </Box>

      {/* AI Diagnosis */}
      {report.checks.some(c => !c.passed && c.explanation) && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text dimColor bold>AI DIAGNOSIS</Text>
          </Box>
          {report.checks.filter(c => !c.passed && c.explanation).map(c => (
            <AICard key={c.id} check={c} />
          ))}
        </Box>
      )}

      <Footer activeAction={activeAction} />
    </Box>
  );
};

export function renderReport(report: HealthReport) {
  let resolveFixRequest: () => void;
  const fixPromise = new Promise<void>((resolve) => {
    resolveFixRequest = resolve;
  });

  const { waitUntilExit, rerender } = render(<ReportDashboard initialReport={report} onFixRequest={() => resolveFixRequest()} />);

  return {
    waitUntilExit,
    fixRequested: () => fixPromise,
    update: (newReport: HealthReport) => {
      rerender(<ReportDashboard initialReport={newReport} onFixRequest={() => resolveFixRequest()} />);
    }
  };
}
