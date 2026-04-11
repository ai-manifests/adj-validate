#!/usr/bin/env node

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { validateEntry, validateDeliberation, computeCalibration, extractScoringPairs, loadEntry } from '../src/index.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function pass(msg) { console.log(`  ${GREEN}\u2713${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}\u2717${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}\u26A0${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}\u2139${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${msg}${RESET}`); }

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
${BOLD}adj-validate${RESET} — Validate ADJ journal entries and audit deliberation records

${BOLD}Usage:${RESET}
  adj-validate <file> [file...]              Validate one or more journal entries
  adj-validate --deliberation <dir>          Validate a complete deliberation record
  adj-validate --calibration <dir> --agent <id> --domain <d>  Verify calibration scoring

${BOLD}Examples:${RESET}
  adj-validate ./entry.json
  adj-validate --deliberation ./deliberation/
  adj-validate --calibration ./journal/ --agent did:adp:test-runner-v2 --domain code.correctness

${BOLD}Options:${RESET}
  --deliberation <dir>    Validate all .json entries in dir as one deliberation
  --calibration <dir>     Audit calibration scoring across deliberations
  --agent <id>            Agent ID for calibration audit
  --domain <domain>       Decision domain for calibration audit
  --json                  Output results as JSON
  --help                  Show this help
`);
  process.exit(0);
}

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const deliberationMode = args.includes('--deliberation');
const calibrationMode = args.includes('--calibration');
const agentId = getArgValue('--agent');
const domain = getArgValue('--domain');
const inputs = args.filter(a => !a.startsWith('--') && a !== agentId && a !== domain);

let totalErrors = 0;
let totalWarnings = 0;

async function run() {
  if (calibrationMode) {
    await runCalibration();
  } else if (deliberationMode) {
    await runDeliberationValidation();
  } else {
    await runEntryValidation();
  }
}

async function runEntryValidation() {
  heading('ADJ Entry Validator');

  for (const input of inputs) {
    console.log(`${DIM}File: ${input}${RESET}`);

    let entry;
    try {
      entry = loadEntry(resolve(input));
    } catch (e) {
      fail(`Failed to load: ${e.message}`);
      totalErrors++;
      continue;
    }

    heading('Schema Validation');
    const result = validateEntry(entry);

    if (result.errors.length === 0) {
      pass('Valid against ADJ entry schema v0');
    } else {
      for (const err of result.errors) { fail(err); totalErrors++; }
    }

    heading('Entry Info');
    info(`Type: ${BOLD}${entry.entry_type}${RESET}`);
    info(`Deliberation: ${entry.deliberation_id}`);
    if (entry.entry_id) info(`Entry ID: ${entry.entry_id}`);

    if (entry.entry_type === 'deliberation_opened') {
      if (entry.decision_class) info(`Decision class: ${entry.decision_class}`);
      if (entry.participants) info(`Participants: ${entry.participants.length} agents`);
      if (entry.action) info(`Action: ${entry.action.kind} → ${entry.action.target}`);
    }

    if (entry.entry_type === 'deliberation_closed') {
      info(`Termination: ${BOLD}${formatTermination(entry.termination)}${RESET}`);
      info(`Rounds: ${entry.round_count}`);
      if (entry.final_tally) {
        info(`Approval: ${(entry.final_tally.approval_fraction * 100).toFixed(1)}% (threshold: ${(entry.final_tally.threshold * 100).toFixed(1)}%)`);
      }
    }

    if (entry.entry_type === 'outcome_observed') {
      info(`Outcome: ${BOLD}${formatOutcome(entry.success)}${RESET}`);
      info(`Class: ${entry.outcome_class}`);
      info(`Reporter: ${entry.reporter_id}`);
      if (entry.ground_truth) info(`${GREEN}Ground truth${RESET}`);
    }

    if (entry.entry_type === 'round_event') {
      info(`Round: ${entry.round}`);
      info(`Event: ${entry.event_kind}`);
      info(`Agent: ${entry.agent_id}`);
      if (entry.target_condition_id) info(`Target condition: ${entry.target_condition_id}`);
    }

    if (result.warnings.length > 0) {
      heading('Warnings');
      for (const w of result.warnings) { warn(w); totalWarnings++; }
    }

    if (inputs.length > 1) console.log(`\n${'─'.repeat(60)}`);
  }

  printResult();
}

async function runDeliberationValidation() {
  heading('ADJ Deliberation Validator');

  const dir = inputs[0];
  if (!dir || !existsSync(dir)) {
    fail(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  console.log(`${DIM}Directory: ${dir} (${files.length} entries)${RESET}`);

  const entries = [];
  for (const file of files) {
    try {
      const obj = loadEntry(resolve(join(dir, file)));
      if (obj.entry_id) entries.push(obj);
    } catch (e) {
      fail(`Failed to load ${file}: ${e.message}`);
      totalErrors++;
    }
  }

  // Sort by timestamp
  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const result = validateDeliberation(entries);

  heading('Entry Summary');
  const typeCounts = {};
  for (const e of entries) {
    typeCounts[e.entry_type] = (typeCounts[e.entry_type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCounts)) {
    info(`${type}: ${count}`);
  }

  heading('Sequencing & Consistency');
  if (result.errors.length === 0) {
    pass('All sequencing and consistency checks passed');
  }
  for (const err of result.errors) { fail(err); totalErrors++; }

  if (result.warnings.length > 0) {
    heading('Warnings');
    for (const w of result.warnings) { warn(w); totalWarnings++; }
  }

  // Deliberation summary
  const opened = entries.find(e => e.entry_type === 'deliberation_opened');
  const closed = entries.find(e => e.entry_type === 'deliberation_closed');
  const outcome = entries.find(e => e.entry_type === 'outcome_observed');

  if (opened || closed) {
    heading('Deliberation Summary');
    if (opened) {
      info(`Deliberation: ${opened.deliberation_id}`);
      if (opened.action) info(`Action: ${opened.action.kind} → ${opened.action.target}`);
      info(`Participants: ${(opened.participants || []).join(', ')}`);
    }
    if (closed) {
      info(`Termination: ${BOLD}${formatTermination(closed.termination)}${RESET}`);
      info(`Rounds: ${closed.round_count}`);
    }
    if (outcome) {
      info(`Outcome: ${BOLD}${formatOutcome(outcome.success)}${RESET} (${outcome.outcome_class}, observed ${outcome.observed_at})`);
    } else {
      info(`Outcome: ${DIM}not yet recorded${RESET}`);
    }
  }

  printResult();
}

async function runCalibration() {
  heading('ADJ Calibration Audit');

  const dir = inputs[0];
  if (!dir || !existsSync(dir)) {
    fail(`Directory not found: ${dir}`);
    process.exit(1);
  }

  if (!agentId) { fail('--calibration requires --agent <id>'); process.exit(1); }
  if (!domain) { fail('--calibration requires --domain <domain>'); process.exit(1); }

  console.log(`${DIM}Agent: ${agentId} | Domain: ${domain}${RESET}`);

  // Load all json files, group by deliberation_id
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const allEntries = [];
  for (const file of files) {
    try {
      const obj = loadEntry(resolve(join(dir, file)));
      if (obj.entry_id) allEntries.push(obj);
    } catch { /* skip non-entry files */ }
  }

  // Group by deliberation
  const byDlb = {};
  for (const e of allEntries) {
    if (!byDlb[e.deliberation_id]) byDlb[e.deliberation_id] = [];
    byDlb[e.deliberation_id].push(e);
  }

  const deliberations = Object.values(byDlb);
  info(`Loaded ${allEntries.length} entries across ${deliberations.length} deliberation(s)`);

  // Extract scoring pairs
  const pairs = extractScoringPairs(deliberations, agentId, domain);

  heading('Scoring Pairs');
  if (pairs.length === 0) {
    warn('No scoring pairs found — agent may not participate in this domain, or no outcomes recorded');
    printResult();
    return;
  }

  for (const p of pairs) {
    const outcome = p.outcome === 1.0 ? `${GREEN}success${RESET}` : p.outcome === 0.0 ? `${RED}failure${RESET}` : `${YELLOW}${p.outcome}${RESET}`;
    const diff = Math.abs(p.confidence - p.outcome);
    const brier = (p.confidence - p.outcome) ** 2;
    info(`confidence: ${p.confidence.toFixed(2)} | outcome: ${outcome} | Brier: ${brier.toFixed(4)}`);
  }

  heading('Calibration Result');
  const cal = computeCalibration(pairs);

  info(`Brier score:       ${cal.brierScore.toFixed(4)}`);
  info(`Calibration value: ${BOLD}${cal.calibrationValue.toFixed(4)}${RESET}`);
  info(`Sample size:       ${cal.sampleSize}`);

  if (cal.calibrationValue >= 0.85) {
    pass('Well calibrated');
  } else if (cal.calibrationValue >= 0.70) {
    info('Moderately calibrated');
  } else if (cal.calibrationValue >= 0.50) {
    warn('Poorly calibrated — agent may be systematically over- or under-confident');
  } else {
    fail('Very poorly calibrated — agent predictions inversely correlate with outcomes');
  }

  printResult();
}

function formatTermination(t) {
  switch (t) {
    case 'converged': return `${GREEN}converged${RESET}`;
    case 'partial_commit': return `${YELLOW}partial commit${RESET}`;
    case 'deadlocked': return `${RED}deadlocked${RESET}`;
    default: return t;
  }
}

function formatOutcome(s) {
  if (s === true || s === 1 || s === 1.0) return `${GREEN}success${RESET}`;
  if (s === false || s === 0 || s === 0.0) return `${RED}failure${RESET}`;
  return `${YELLOW}graded: ${s}${RESET}`;
}

function printResult() {
  console.log('');
  if (totalErrors === 0 && totalWarnings === 0) {
    console.log(`${GREEN}${BOLD}\u2713 All checks passed${RESET}`);
    process.exit(0);
  } else if (totalErrors === 0) {
    console.log(`${GREEN}${BOLD}\u2713 All checks passed${RESET} ${YELLOW}(${totalWarnings} warning${totalWarnings > 1 ? 's' : ''})${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}\u2717 ${totalErrors} error(s) found${RESET}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(2);
});
