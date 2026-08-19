import { readFile, writeFile } from 'node:fs/promises';

const README = new URL('../README.md', import.meta.url);
const PLAN = new URL('../PLAN.md', import.meta.url);

function insertAfter(text, anchor, addition, marker) {
  if (text.includes(marker)) return text;
  const index = text.indexOf(anchor);
  if (index < 0) throw new Error(`anchor-not-found:${marker}`);
  const end = index + anchor.length;
  return text.slice(0, end) + addition + text.slice(end);
}

function insertBefore(text, anchor, addition, marker) {
  if (text.includes(marker)) return text;
  const index = text.indexOf(anchor);
  if (index < 0) throw new Error(`anchor-not-found:${marker}`);
  return text.slice(0, index) + addition + text.slice(index);
}

function replaceOnce(text, from, to, marker) {
  if (text.includes(to)) return text;
  const index = text.indexOf(from);
  if (index < 0) throw new Error(`anchor-not-found:${marker}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

let readme = await readFile(README, 'utf8');

const deploymentRow = '| Tax production exception archive DR provider continuous assurance production deployment canary | `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.ts` / `worker-runtime/continuous-assurance-production-canary-worker.mjs` / `scripts/deploy-continuous-assurance-production-canary.mjs` | deployed Worker version/config identity、read-only runtime→DO→engine wiring、R2 artifact、independent verification、redacted deploy planを検証 (#145) |';
readme = insertAfter(readme, deploymentRow,
  '\n| Tax production exception archive DR provider continuous assurance production provider canary | `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.ts` / `worker-runtime/continuous-assurance-production-provider-canary-worker.mjs` | two-person authorization下のhealth/audit/primary+backup retrieval/pager dedupe、R2 artifact、dedicated verifierを検証 (#149) |\n| Tax production exception archive DR provider continuous assurance production operations rollout | `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.ts` | observe-only→maintenance→DR exercise→steady-stateの4 phaseを検証し、clean時は`steady-state-enabled` + operational obligationsでvalidator chainを終了 (#152) |',
  'production operations rollout | `src/workers-coordinator');

const deploymentDocLink = '- [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md`](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md)';
readme = insertAfter(readme, deploymentDocLink,
  '\n- [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md`](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md)\n- [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md`](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md)',
  'docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md`](./docs');

const deploymentCommand = 'npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';
readme = insertAfter(readme, deploymentCommand,
  '\nnpm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary\nnpm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout',
  'npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout');

const issue145 = '- [#145](https://github.com/azumag/unzen/issues/145): production exception archive DR provider continuous assurance production deployment canary';
readme = insertBefore(readme, issue145,
  '- [#152](https://github.com/azumag/unzen/issues/152): production exception archive DR provider continuous assurance production operations rollout — exact provider-canary evidence、two-person rollout authorization、4 phase順序/観測窓、phase-specific action allowlist、SLO/error budget、rotation、backup-source DR、incident/control/identityを照合。clean時は`steady-state-enabled`、`bottlenecksToIssue: []`と継続運用obligationを返しvalidator chainを終了\n- [#149](https://github.com/azumag/unzen/issues/149): production exception archive DR provider continuous assurance production provider canary — exact deployment canary evidenceを再検証し、health/audit/primary+backup retrieval/pager dedupeだけをbounded two-person authorizationで実行。R2 artifact + dedicated verifierを要求し、次のproduction operations rolloutへ進む\n',
  '- [#152](https://github.com/azumag/unzen/issues/152)');

const deploymentRelated = '| [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md`](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md) | deployed version/config identity、read-only runtime/engine wiring、R2 + independent verifier、redacted deployment helper、次bottleneck | #145 deployment-plan + read-only canary contract |';
readme = insertAfter(readme, deploymentRelated,
  '\n| [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md`](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md) | bounded production provider/pager canary、two-person authorization、archive integrity、R2 + dedicated verifier、次bottleneck | #149 production-candidate provider canary contract |\n| [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md`](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md) | 4-phase terminal rollout、phase allowlist、SLO/error budget、rotation/DR、operational obligations | #152 terminal validator contract。clean時は次validatorなし |',
  '| [`docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md`](./docs');

const readinessNote = 'contract gateが揃っていても、実provider・実tax filing・実browser artifactがcaptured-and-verifiedになるまではproduction-ready systemとは表現しません。';
readme = insertAfter(readme, readinessNote,
  '\n\n#152のterminal rolloutも同様で、CI fixtureの`steady-state-enabled`は実provider rollout完了を証明しません。実運用への昇格には、各phaseの外部`captured-and-verified` / `production-approved` evidenceが必要です。',
  '#152のterminal rolloutも同様');

await writeFile(README, readme);

let plan = await readFile(PLAN, 'utf8');
plan = replaceOnce(plan, '# unzen-LLM 計画書 v3.13', '# unzen-LLM 計画書 v3.15', 'plan-title-v3.15');

const step41 = '41. [Publisher tax filing production exception archive DR provider continuous assurance production deployment canary (#145)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md) で、Cloudflare Worker `version_metadata` とdeploy-time config fingerprintをcontroller/runtime/engine/provider/evidence/pager/verifierへ固定し、controller→runtime→同一SQLite DO `runScheduled()`→engine、engine-observed adapter Service Binding identity、R2 canary artifact、independent verifier、bad-secret/duplicate/digest/trust negative path、secret-redacted Wrangler deployment helperを検証する。このcanaryはnormal Cronと競合するprovider write/key rotation/DR exerciseを発行しないread-only `idle` tickに限定し、CI/Miniflare/dry-run passをactual Cloudflare deployment evidenceとは扱わない。次の`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary`へ進む';
plan = insertAfter(plan, step41,
  '\n42. [Publisher tax filing production exception archive DR provider continuous assurance production provider canary (#149)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md) で、#145のexact deployment-canary EvidenceEnvelopeを独立再検証し、two-person / time-bounded authorizationの下でprovider health、audit read、primary/backup archive retrieval、pager canary+dedupeだけを実行する。key rotation / DR failover / archive mutationはこのbounded pathから除外し、provider/account/storage/archive/deployment identity、SHA-256 integrity、R2 artifact、dedicated independent verifierを照合する。CI fixtureをactual provider operationとは扱わず、cleanなreal canary後は`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout`へ進む\n43. [Publisher tax filing production exception archive DR provider continuous assurance production operations rollout (#152)](./docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md) で、exact provider-canary evidenceを再検証し、`observe-only`→`maintenance-enabled`→`dr-exercise-enabled`→`steady-state-enabled`の4 phaseを順序・観測窓・phase-specific action allowlist付きで照合する。maintenanceの明示key rotation、backup-source DR exercise、SLO/error budget、alert/incident/control、provider/archive/deployment identityをfail-closeで検証し、clean completion時は`decision: steady-state-enabled`、`bottlenecksToIssue: []`とnext cycle/rotation/DR/retention/on-call/rollbackのoperational obligationsを返す。ここをvalidator chainの終端とし、新しいvalidator bottleneckは具体的な実装gapが見つからない限り追加しない',
  '43. [Publisher tax filing production exception archive DR provider continuous assurance production operations rollout (#152)]');
plan = replaceOnce(plan, '42. ~~[Chrome Prompt API feasibility harness (#93)]', '44. ~~[Chrome Prompt API feasibility harness (#93)]', 'chrome-step-44');
plan = replaceOnce(plan, '43. [InferenceBackend / WorkerCapability 抽象化 (#94)]', '45. [InferenceBackend / WorkerCapability 抽象化 (#94)]', 'inference-step-45');
plan = replaceOnce(plan, '**ドキュメントバージョン**: 3.13', '**ドキュメントバージョン**: 3.15', 'plan-footer-v3.15');
const changelogAnchor = '- v3.13: #145 production exception archive DR provider continuous assurance production deployment canaryを7.1項へ追加。';
plan = insertBefore(plan, changelogAnchor,
  '- v3.15: #149 production provider canaryと#152 terminal production operations rolloutを7.1項へ追加。#149ではexact deployed evidence + two-person bounded authorizationでhealth/audit/primary+backup retrieval/pager dedupeのみを許可し、R2 artifact + dedicated verifierを要求。#152では4 phase staged rollout、phase-specific action allowlist、SLO/error budget、authorized key rotation、backup-source DR、incident/control/identityを検証し、clean時は`steady-state-enabled` + operational obligations + empty bottleneck listでvalidator chainを終端\n',
  '- v3.15: #149 production provider canary');
await writeFile(PLAN, plan);

console.log('docs #151 synchronized');
