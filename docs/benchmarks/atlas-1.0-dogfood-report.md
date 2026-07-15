# Atlas 1.0 dogfood benchmark report

Date: 2026-07-14

## Verdict

The protocol-corrected replication did **not** pass the preregistered point-estimate gate. Atlas achieved 0.750 macro recall@5; the frozen minimum was 0.800. The deterministic ripgrep baseline achieved 0.292.

This result blocks any claim that Atlas 1.0 met the frozen benchmark gate. It does not by itself establish a functional, security, or packaging defect. Whether the unmet descriptive benchmark blocks publishing the otherwise validated package is an explicit release decision.

## Protocol

The outcome-free protocol, twelve tasks, gold files, controls, metrics, and limitations are retained in [`atlas-1.0-preregistration.json`](./atlas-1.0-preregistration.json). Both arms used the same promotion working tree. No model, provider, LLM judge, estimated token count, or paid API was used.

## Run chronology

1. The first invocation stopped before either arm ran because the isolated process could not resolve `rg`. It produced no outcomes and did not alter the preregistration.
2. The initial completed invocation was invalid as a retrieval comparison: the runner passed `characterBudget` to the `search` action, whose frozen public contract does not accept that field. Atlas correctly rejected all 12 requests. The raw result is retained rather than discarded.
3. The protocol-corrected replication removed only that unsupported field. Tasks, queries, gold files, ordering, scoring, and the ripgrep baseline remained frozen.
4. A general path-identity ranking experiment was then run against a distinct candidate. Its macro recall@5, mean reciprocal rank, and tasks-with-gold were identical to the corrected replication. Because it supplied no measured benchmark benefit and added ranking complexity, the experiment was reverted.

## Aggregates

| Run | Atlas recall@5 | Atlas MRR | Atlas tasks with gold | Atlas failures | Baseline recall@5 | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Invalid initial invocation | 0.000 | 0.000 | 0/12 | 12 | 0.292 | Invalid treatment requests; not retrieval performance |
| Protocol-corrected replication | 0.750 | 0.771 | 11/12 | 0 | 0.292 | Did not pass the 0.800 gate |
| Post-fix ranking experiment | 0.750 | 0.771 | 11/12 | 0 | 0.292 | Null primary and secondary effect; experiment reverted |

For the corrected replication, Atlas improved macro recall@5 by 0.458, mean reciprocal rank by 0.629, and tasks with at least one gold file by 7 relative to the baseline. These are descriptive results from twelve authored tasks, not population estimates.

Mean query time was 6.589 ms for Atlas and 79.950 ms for the ripgrep baseline in the corrected run. This is not a universal speed comparison: ripgrep performed per-query scans, while Atlas paid separate install and full-index costs.

## Raw evidence

The raw evidence is retained alongside this report:

- [`raw/atlas-1.0-invalid-initial.json`](./raw/atlas-1.0-invalid-initial.json) — invalid initial invocation; SHA-256 `95d13f678cab76c4d37dcda38f2064cb3f4adfaaa62dfc579c700997f0c62b5d`
- [`raw/atlas-1.0-protocol-corrected.json`](./raw/atlas-1.0-protocol-corrected.json) — corrected replication; SHA-256 `6831c3c29bf0362c40fa54a2cd111e0886e7019f4c773f16699f5e75f4861a19`
- [`raw/atlas-1.0-null-ranking-experiment.json`](./raw/atlas-1.0-null-ranking-experiment.json) — null-effect ranking experiment; SHA-256 `7af0b8638d052b7cf3a9428256ae6ab591ccc45e2b839c86e600599776a9fafb`

The corrected replication evaluated preregistered candidate SHA-256 `16578a8a86665700e1221fc50f59711a16881c981cb7201da004121ecf5f57f0`. The reverted experiment evaluated candidate SHA-256 `e1f5ac26ab8423a1bcd4842a75c5ed71219dd354ca41440a7486ced5d364e652` and is not a release candidate.

## Limitations

- The tasks and gold files were authored from one repository and are not a population sample.
- The baseline is deterministic ripgrep file retrieval, not Atlas 0.1 or an agent using arbitrary shell exploration.
- The source tree was the promotion working tree rather than a clean public release commit.
- Timing includes different work in each arm and is environment-specific.
- No provider token or cost comparison is applicable; telemetry fields remain null rather than estimated.
