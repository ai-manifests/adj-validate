# adj-validate

Validate [ADJ](https://adj-manifest.dev) journal entries, audit deliberation records, and verify calibration scoring.

## Install

```bash
npm install -g adj-validate
```

## Usage

### Validate journal entries

```bash
adj-validate ./entry.json
adj-validate ./opened.json ./closed.json ./outcome.json
```

### Validate a deliberation record

Pass a directory of entry files to check sequencing, completeness, and consistency:

```bash
adj-validate --deliberation ./deliberation/
```

Checks:
- First entry is `deliberation_opened`, last (before outcome) is `deliberation_closed`
- Timestamp ordering across entries
- Participant consistency (proposal agents match declared participants)
- Hash chain integrity (if present)
- Outcome timing (`observed_at` after `deliberation_closed`)
- Tally arithmetic in `deliberation_closed` (approve + reject + abstain = total, fractions match)
- Termination consistency (converged requires approval >= threshold)

### Audit calibration scoring

Verify Brier score computation for an agent across deliberations:

```bash
adj-validate --calibration ./journal/ --agent did:adp:test-runner-v2 --domain code.correctness
```

Extracts (confidence, outcome) pairs, computes the Brier score, and reports the calibration value.

## Semantic Checks

| Check | Type |
|-------|------|
| Tally arithmetic (weights sum, fractions match) | Error |
| Termination vs tally consistency | Error |
| Falsification evidence requires target_agent_id | Error |
| Outcome before deliberation_closed | Error |
| Entry sequencing (proposals before rounds, correct ordering) | Warning |
| Participant not in declared list | Warning |
| Partial hash chain | Warning |
| Ground truth with low reporter confidence | Warning |

## Programmatic Use

```javascript
import { validateEntry, validateDeliberation, computeCalibration, extractScoringPairs } from 'adj-validate';

const result = validateEntry(entry);
const dlbResult = validateDeliberation(entries);
const cal = computeCalibration(pairs);
```

## Status

**v0.1** — Validates against ADJ spec v0.
