import { readFileSync } from 'node:fs';
import path from 'node:path';

import { evaluateLocationGate } from '../src/ops/locationGate.ts';

const NUMBER_FIELDS = [
  'paidPlays',
  'reattemptOpportunities',
  'reattemptsWithin10Min',
  'failedInputs',
  'focusDisputes',
  'scheduledMinutes',
  'unavailableMinutes',
];

function observationsOf(input) {
  if (!Array.isArray(input)) throw new Error('root must be an array');
  return input.map((value, index) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`row ${String(index + 1)} must be an object`);
    }
    if (typeof value.locationId !== 'string' || typeof value.date !== 'string') {
      throw new Error(`row ${String(index + 1)} locationId/date must be strings`);
    }
    for (const field of NUMBER_FIELDS) {
      if (typeof value[field] !== 'number') {
        throw new Error(`row ${String(index + 1)} ${field} must be a number`);
      }
    }
    return {
      locationId: value.locationId,
      date: value.date,
      paidPlays: value.paidPlays,
      reattemptOpportunities: value.reattemptOpportunities,
      reattemptsWithin10Min: value.reattemptsWithin10Min,
      failedInputs: value.failedInputs,
      focusDisputes: value.focusDisputes,
      scheduledMinutes: value.scheduledMinutes,
      unavailableMinutes: value.unavailableMinutes,
    };
  });
}

try {
  const inputArg = process.argv[2];
  if (!inputArg) throw new Error('usage: node scripts/location-gate.mjs <observations.json>');
  const inputPath = path.resolve(process.cwd(), inputArg);
  const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
  const report = evaluateLocationGate(observationsOf(parsed));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.readyForSecondPhase) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`LOCATION GATE INPUT ERROR: ${String(error)}\n`);
  process.exitCode = 1;
}
