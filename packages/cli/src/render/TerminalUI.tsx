import React, { useEffect, useState } from 'react';
import { Box, Text, render } from 'ink';
import gradient from 'gradient-string';
import figlet from 'figlet';
import { HealthReport, CheckResult } from '@devpulse/shared';

const icon = (check: CheckResult) =>
  check.passed ? '✓' : check.severity === 'critical' ? '✗' : '!';

const color = (check: CheckResult) =>
  check.passed ? 'green' : check.severity === 'critical' ? 'red' : 'yellow';

const ScoreBar = ({ score }: { score: number }) => {
  const [animatedScore, setAnimatedScore] = useState(0);

  useEffect(() => {
    let current = 0;
    const interval = setInterval(() => {
      current += Math.ceil((score - current) / 10);
      if (current >= score) {
        current = score;
        clearInterval(interval);
      }
      setAnimatedScore(current);
    }, 30);
    return () => clearInterval(interval);
  }, [score]);

  const filled = Math.round(animatedScore / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const c = animatedScore >= 80 ? 'green' : animatedScore >= 50 ? 'yellow' : 'red';
  return <Text color={c}>{bar} {animatedScore}/100</Text>;
};

const Header = () => {
    const title = figlet.textSync('DevPulse', { font: 'Slant' });
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text>{gradient.pastel(title)}</Text>
            <Text italic color="cyan">AI-Powered Environment Diagnostician</Text>
        </Box>
    );
};

export function renderReport(report: HealthReport) {
  const { waitUntilExit } = render(
    <Box flexDirection="column" padding={1}>
      <Header />
      <Box marginY={1}>
        <Text bold>Health Score: </Text>
        <ScoreBar score={report.score} />
      </Box>

      {['runtime','package_manager','env_var','tool'].map(cat => {
        // @ts-ignore
        const checks = report.checks.filter(c => c.category === cat);
        if (!checks.length) return null;
        return (
          <Box key={cat} flexDirection="column" marginBottom={1}>
            <Text dimColor>{cat.replace('_',' ').toUpperCase()}</Text>
            {checks.map(c => (
              <Box key={c.id} gap={1}>
                {/* @ts-ignore */}
                <Text color={color(c)}>{icon(c)}</Text>
                <Text>{c.name.padEnd(20)}</Text>
                <Text dimColor>
                  {c.found ? `found ${c.found}` : 'not found'}
                  {c.required ? ` · required ${c.required}` : ''}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}

      {report.checks.filter(c => !c.passed && c.explanation).map(c => (
        <Box key={c.id} flexDirection="column" 
             borderStyle="single" borderColor="yellow" padding={1} marginY={1}>
          <Text color="yellow">AI · {c.name}</Text>
          <Text>{c.explanation}</Text>
          {c.fixCommand && <Text color="green">$ {c.fixCommand}</Text>}
        </Box>
      ))}
    </Box>
  );
  return waitUntilExit();
}
