import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, '..', 'schema', 'v0.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const VALID_ENTRY_TYPES = ['deliberation_opened', 'proposal_emitted', 'round_event', 'deliberation_closed', 'outcome_observed'];

/**
 * Validate a single journal entry against schema and semantic rules.
 * @param {object} entry
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateEntry(entry) {
  const errors = [];
  const warnings = [];

  // Schema validation
  const schemaValid = validateSchema(entry);
  if (!schemaValid && validateSchema.errors) {
    for (const err of validateSchema.errors) {
      const path = err.instancePath || '(root)';
      errors.push(`${path}: ${err.message}`);
    }
  }

  if (!entry || typeof entry !== 'object') {
    return { valid: errors.length === 0, errors, warnings };
  }

  // Semantic: outcome timing
  if (entry.entry_type === 'outcome_observed') {
    if (entry.reporter_confidence === 1.0) {
      warnings.push('reporter_confidence is 1.0 — perfect confidence in outcome observation is unusual');
    }
    if (entry.ground_truth && entry.reporter_confidence != null && entry.reporter_confidence < 0.9) {
      warnings.push(`ground_truth is true but reporter_confidence is ${entry.reporter_confidence} — ground truth should have high confidence`);
    }
    if (entry.success === true) entry._successValue = 1.0;
    else if (entry.success === false) entry._successValue = 0.0;
  }

  // Semantic: deliberation_closed tally consistency
  if (entry.entry_type === 'deliberation_closed' && entry.final_tally) {
    const t = entry.final_tally;
    const computedTotal = (t.approve_weight || 0) + (t.reject_weight || 0) + (t.abstain_weight || 0);
    if (Math.abs(computedTotal - (t.total_weight || 0)) > 0.01) {
      errors.push(`final_tally: total_weight (${t.total_weight}) does not match sum of approve + reject + abstain (${computedTotal.toFixed(3)})`);
    }

    const nonAbstaining = (t.approve_weight || 0) + (t.reject_weight || 0);
    if (nonAbstaining > 0) {
      const computedApproval = (t.approve_weight || 0) / nonAbstaining;
      if (Math.abs(computedApproval - (t.approval_fraction || 0)) > 0.01) {
        errors.push(`final_tally: approval_fraction (${t.approval_fraction}) does not match computed (${computedApproval.toFixed(3)})`);
      }
    }

    if ((t.total_weight || 0) > 0) {
      const computedParticipation = nonAbstaining / (t.total_weight || 1);
      if (Math.abs(computedParticipation - (t.participation_fraction || 0)) > 0.01) {
        errors.push(`final_tally: participation_fraction (${t.participation_fraction}) does not match computed (${computedParticipation.toFixed(3)})`);
      }
    }

    // Termination vs tally consistency
    if (entry.termination === 'converged') {
      if ((t.approval_fraction || 0) < (t.threshold || 0)) {
        errors.push(`termination is "converged" but approval_fraction (${t.approval_fraction}) < threshold (${t.threshold})`);
      }
    }
  }

  // Semantic: round_event targeting
  if (entry.entry_type === 'round_event') {
    const needsTarget = ['falsification_evidence', 'acknowledge', 'reject', 'amend'];
    if (needsTarget.includes(entry.event_kind) && !entry.target_condition_id) {
      warnings.push(`event_kind "${entry.event_kind}" typically targets a dissent condition but target_condition_id is null`);
    }

    if (entry.event_kind === 'falsification_evidence' && !entry.target_agent_id) {
      errors.push('falsification_evidence requires target_agent_id');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a complete deliberation record (ordered array of entries).
 * Checks sequencing, completeness, participant consistency, and hash chains.
 * @param {object[]} entries - Array of journal entries for one deliberation, in order
 * @returns {{ valid: boolean, errors: string[], warnings: string[], entries: object[] }}
 */
export function validateDeliberation(entries) {
  const errors = [];
  const warnings = [];
  const entryResults = [];

  // Validate each entry individually
  for (const entry of entries) {
    const result = validateEntry(entry);
    entryResults.push({ entry_id: entry.entry_id, entry_type: entry.entry_type, ...result });
    for (const e of result.errors) errors.push(`[${entry.entry_id}] ${e}`);
    for (const w of result.warnings) warnings.push(`[${entry.entry_id}] ${w}`);
  }

  if (entries.length === 0) {
    errors.push('deliberation record is empty');
    return { valid: false, errors, warnings, entries: entryResults };
  }

  // Sequencing: first entry must be deliberation_opened
  if (entries[0].entry_type !== 'deliberation_opened') {
    errors.push(`first entry is "${entries[0].entry_type}" — expected "deliberation_opened"`);
  }

  // Sequencing: all entries share deliberation_id
  const dlbIds = new Set(entries.map(e => e.deliberation_id).filter(Boolean));
  if (dlbIds.size > 1) {
    errors.push(`entries reference ${dlbIds.size} different deliberation_ids`);
  }

  // Sequencing: deliberation_closed should come after all proposals and round events
  const closedIdx = entries.findIndex(e => e.entry_type === 'deliberation_closed');
  const outcomeIdx = entries.findIndex(e => e.entry_type === 'outcome_observed');

  if (closedIdx < 0) {
    warnings.push('no deliberation_closed entry — deliberation record is incomplete');
  }

  if (outcomeIdx >= 0 && closedIdx >= 0 && outcomeIdx < closedIdx) {
    errors.push('outcome_observed appears before deliberation_closed');
  }

  // Sequencing: proposals should come before round events
  const lastProposalIdx = entries.reduce((max, e, i) => e.entry_type === 'proposal_emitted' ? i : max, -1);
  const firstRoundIdx = entries.findIndex(e => e.entry_type === 'round_event');
  if (lastProposalIdx >= 0 && firstRoundIdx >= 0 && lastProposalIdx > firstRoundIdx) {
    warnings.push('proposal_emitted appears after round_event — proposals should precede rounds');
  }

  // Timestamp ordering
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].timestamp && entries[i - 1].timestamp) {
      if (new Date(entries[i].timestamp) < new Date(entries[i - 1].timestamp)) {
        warnings.push(`entry ${entries[i].entry_id} has timestamp before previous entry ${entries[i - 1].entry_id}`);
      }
    }
  }

  // Participant consistency
  const opened = entries.find(e => e.entry_type === 'deliberation_opened');
  if (opened && opened.participants) {
    const declaredParticipants = new Set(opened.participants);
    const proposalAgents = entries
      .filter(e => e.entry_type === 'proposal_emitted' && e.proposal)
      .map(e => e.proposal.agent_id || e.proposal.AgentId)
      .filter(Boolean);

    for (const agent of proposalAgents) {
      if (!declaredParticipants.has(agent)) {
        warnings.push(`agent "${agent}" submitted a proposal but is not in participants list`);
      }
    }
  }

  // Hash chain verification
  const hashEntries = entries.filter(e => e.prior_entry_hash != null);
  if (hashEntries.length > 0 && hashEntries.length < entries.length - 1) {
    warnings.push(`hash chain is partial — ${hashEntries.length} of ${entries.length} entries have prior_entry_hash`);
  }

  // Outcome timing
  if (outcomeIdx >= 0 && closedIdx >= 0) {
    const outcomeTime = new Date(entries[outcomeIdx].observed_at || entries[outcomeIdx].timestamp);
    const closedTime = new Date(entries[closedIdx].timestamp);
    if (outcomeTime < closedTime) {
      errors.push('outcome observed_at is before deliberation_closed timestamp');
    }
  }

  return { valid: errors.length === 0, errors, warnings, entries: entryResults };
}

/**
 * Compute Brier score calibration from a set of (confidence, outcome) pairs.
 * @param {{ confidence: number, outcome: number }[]} pairs
 * @returns {{ brierScore: number, calibrationValue: number, sampleSize: number }}
 */
export function computeCalibration(pairs) {
  if (pairs.length === 0) {
    return { brierScore: 0, calibrationValue: 0.5, sampleSize: 0 };
  }

  let brierSum = 0;
  for (const { confidence, outcome } of pairs) {
    const diff = confidence - outcome;
    brierSum += diff * diff;
  }

  const brierScore = brierSum / pairs.length;
  const calibrationValue = 1 - brierScore;

  return {
    brierScore: Math.round(brierScore * 10000) / 10000,
    calibrationValue: Math.round(calibrationValue * 10000) / 10000,
    sampleSize: pairs.length,
  };
}

/**
 * Extract (confidence, outcome) pairs from a set of deliberation records
 * for a specific agent and domain.
 * @param {object[][]} deliberations - Array of deliberation records (each an array of entries)
 * @param {string} agentId
 * @param {string} domain
 * @returns {{ confidence: number, outcome: number }[]}
 */
export function extractScoringPairs(deliberations, agentId, domain) {
  const pairs = [];

  for (const entries of deliberations) {
    const proposal = entries.find(e =>
      e.entry_type === 'proposal_emitted' &&
      e.proposal &&
      (e.proposal.agent_id === agentId || e.proposal.AgentId === agentId) &&
      (e.proposal.domain === domain || e.proposal.Domain === domain)
    );

    const outcome = [...entries]
      .filter(e => e.entry_type === 'outcome_observed')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

    if (proposal && outcome) {
      const confidence = proposal.proposal.confidence ?? proposal.proposal.Confidence;
      const success = typeof outcome.success === 'boolean'
        ? (outcome.success ? 1.0 : 0.0)
        : outcome.success;

      if (confidence != null && success != null) {
        pairs.push({ confidence, outcome: success });
      }
    }
  }

  return pairs;
}

/**
 * Load an entry from a file path.
 * @param {string} filePath
 * @returns {object}
 */
export function loadEntry(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
