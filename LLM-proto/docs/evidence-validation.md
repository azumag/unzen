# Evidence envelope validation

Issue #101の最初の実装として、`src/evidence.ts`にevidence envelopeの型、validator、production readiness判定を追加した。

## 対象API

- `EvidenceEnvelope<TPayload>`
- `SyntheticEvidenceEnvelope<TPayload>`
- `SelfReportedEvidenceEnvelope<TPayload>`
- `CapturedAndVerifiedEvidenceEnvelope<TPayload>`
- `validateEvidenceEnvelope()`
- `evidenceSupportsReadiness()`

## 判定の基本ルール

### `synthetic-fixture`

- 最大readinessは`contract-tested`
- `production-candidate`や`production-approved`を宣言するとinvalid
- unit testの`pass`はproduction readinessへ昇格しない

### `self-reported-runtime`

- 最大readinessは`runtime-observed`
- runtime自身のreportとして扱い、production判断の単独根拠にはしない

### `captured-and-verified`

以下をすべて満たす必要がある。

- 対応schema version
- producer name / version / commit SHA
- run IDとcapture timestamp
- runtime / runtime version / execution surface
- OS metadata
- browser surfaceの場合はbrowser name / version
- feature / scenario / expected result
- artifact locator / SHA-256 / expiration
- verifier name / version / verification timestamp / pass result
- verifierが呼び出し側のtrust listに含まれる
- 外部artifact loaderがlocatorからartifactを取得できる
- 取得したartifactのSHA-256がenvelopeと一致する
- 独立したverifier callbackがartifactを再検証し、envelopeと一致するattestationを返す
- artifactが期限切れでない

## 重要なtrust boundary

`verification.result: "pass"`や`evidenceLevel: "captured-and-verified"`をobjectへ書くだけでは、検証済み証拠にならない。SHA-256が一致するだけでもprovenanceの証明にはならない。

`validateEvidenceEnvelope()`へ渡す以下の設定は、untrusted envelopeとは別の信頼境界から提供する。

```ts
const result = await validateEvidenceEnvelope(envelope, {
  trustedVerifiers: [
    {
      name: 'unzen-ci-evidence-verifier',
      version: '1.0.0',
    },
  ],
  loadArtifact: async (locator) => artifactStore.read(locator),
  verifyArtifact: async ({ envelope, artifactContent, actualSha256 }) => {
    return verifier.verify({
      envelope,
      artifactContent,
      actualSha256,
    });
  },
});
```

`trustedVerifiers`、`loadArtifact`、`verifyArtifact`をevidence payload自身から組み立ててはならない。`verifyArtifact`はCI署名、artifact store metadata、operator attestation等を確認する信頼済み実装を使用する。

validatorは1回のvalidation operation中、base validationとcaptured-only validationの両方で参照する`producer`、`environment`、`redaction`のobject referenceと、その共通primitive fieldを最初の読取りでsnapshotする。特に`environment.executionSurface`は同じsnapshotをbase validationとbrowser metadata要件判定で共有するため、getterや同一objectを持つ別コードが途中で値を書き換えてvalidation branchを切り替えることはできない。captured-onlyの`scenario`は`captured-and-verified` branchへ入った場合だけ一度読み、synthetic/self-reported evidenceでは`scenario`、`artifact`、`verification`を不要にeager readしない。getterがthrowした場合はそのfieldを欠損値として扱い、既存のvalidation issueへfail-closeする。

`loadArtifact()`のTypeScript戻り値もruntimeではuntrustedとして扱う。文字列は従来どおりそのまま扱うが、`ArrayBuffer`または`Uint8Array`はvalidator境界でgenuineなbinary objectかを確認し、caller-owned viewの`byteLength`、`buffer`、`byteOffset`、iterator、`slice()`、constructor/species hookを使わずにowned base `Uint8Array`へsnapshotする。Proxy-wrapped、detached、その他の無効なbinary値はnative internal-slot例外を外へ漏らさず`artifact-load-failed`としてfail-closeする。

binary artifactでは、SHA-256計算と後段の`verifyArtifact()`へ同じowned snapshotを使用する。したがって、loaderが返した元のbuffer/viewがdigest計算後に変更されても、independent verifierが見るbytesはaccepted digestの対象からずれない。

## Validation status

| Status | 意味 |
|---|---|
| `valid` | envelope、artifact integrity、独立attestationが通った |
| `invalid` | schema、digest、期限、verifier、attestation、readiness等に問題がある |
| `not-evaluated` | artifact loaderまたは独立verifierがなく、Level 3として評価できない。loaderが無効なruntime値を返した場合もfail-closeしてここに留める |

`not-evaluated`は`valid`として扱わない。

## Production readiness判定

```ts
const canPromote = evidenceSupportsReadiness(
  result,
  'production-candidate',
);
```

この関数は次の場合だけ`true`を返す。

- validation statusが`valid`
- effective evidence levelが`captured-and-verified`
- effective readinessが要求値以上

synthetic fixtureやself-reported runtimeは、readiness文字列を偽装してもproduction判断に利用できない。

## テスト

```bash
cd LLM-proto
npm run test:evidence
```

unit testでは以下を確認する。

- synthetic fixtureを`contract-tested`に留める
- synthetic fixtureからproduction readinessを生成できない
- artifact loaderなしの手書きLevel 3 objectを`not-evaluated`にする
- digest一致だけではLevel 3を認めない
- trusted verifier、freshness、digest、独立attestationが揃ったartifactを受理する
- attestation不一致、digest不一致、期限切れ、schema不一致、unknown verifierを拒否する
- browser evidenceにbrowser metadataを必須とする
- shared metadata reference / primitive fieldをoperation中に再読せず、最初の`executionSurface`をbrowser metadata判定にも使用する
- synthetic evidenceではcaptured-onlyの`scenario` / `artifact` / `verification`を読まない
- Proxy-wrappedまたはdetached binary artifactをnative例外なしでfail-closeする
- hostile `Uint8Array` subclassのcaller-defined byte access hookを実行しない
- `ArrayBuffer`/`Uint8Array`のowned snapshotをdigestとindependent verifierで共有し、元bufferのmutationから隔離する

## このPRの範囲外

- 既存`workers-coordinator-*` report型の一括migration
- downstream gateへのenvelope伝播
- artifact store / CI uploader / verifier serviceの実装
- 既存test・script名のrename
- real-browser integration artifactの生成

これらはIssue #101の後続PRで段階的に対応する。
