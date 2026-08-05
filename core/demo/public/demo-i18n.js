/**
 * demo-i18n.js — copy / i18n structure for the demo page.
 *
 * Requirement (issue #104): the demo's copy must not be hard-coded inline
 * English scattered through the markup/JS. All user-facing strings live in
 * this module under per-language dictionaries. English is the fallback; a
 * minimal en/ja switch is provided in the page header.
 *
 * `makeI18n(lang)` returns a `t(key, params)` function. Keys are dot paths into
 * the dictionary (arrays are treated as opaque leaf values). `{name}` tokens
 * in templates are replaced from `params`.
 *
 * Pure module: importable from both demo.js (browser) and vitest tests.
 */

export const LANGUAGES = Object.freeze(['en', 'ja']);

export const messages = {
  en: {
    common: {
      title: 'unzen core E2E Demo',
      subtitle: 'Run registered functions in your browser sandbox, with automatic server-side fallback.',
      demoNotice: 'Demo only. This page is not a production system and makes no production guarantees. Timings and statistics are measured in this session and reset on reload.',
      howItWorksHeading: 'How it works',
      howItWorks: {
        item1: 'Browser first: the manifest and function source are fetched, then the function runs in a QuickJS interpreter over WebAssembly inside a Web Worker — off your page\u2019s main thread.',
        item2: 'Automatic fallback: if the browser attempt fails (e.g. a runtime error), the same function is executed server-side.',
        item3: 'Cancellation is yours: cancel aborts the run immediately and never triggers a server fallback.',
      },
      securityHeading: 'Security boundaries (what this demo actually shows)',
      securityNote: 'The sandbox isolates untrusted function code from your page: it runs in a separate Web Worker thread in a QuickJS interpreter with eval/Function/Proxy removed and built-in prototypes frozen. That protects your page from the function code. It does NOT replace a server-side trust boundary, a Content Security Policy, or authentication.',
      languageLabel: 'Language',
      reset: 'Reset all',
      run: 'Run',
      cancel: 'Cancel',
      retry: 'Retry',
      loadSample: 'Load sample data',
      executing: 'Running…',
      ready: 'Ready',
      sampleNote: 'Fictional sample data only — do not enter real credit card numbers, phone numbers, or passwords.',
    },
    states: {
      idle: 'Ready',
      validating: 'Validating input…',
      preparing: 'Preparing (fetching manifest and code)…',
      'running-in-browser': 'Running in browser sandbox…',
      'falling-back-to-server': 'Browser attempt failed — falling back to server…',
      'running-on-server': 'Running on server…',
      succeeded: 'Succeeded',
      failed: 'Failed',
      cancelling: 'Cancelling…',
      cancelled: 'Cancelled',
    },
    errorCategories: {
      input: 'Input error',
      function: 'Function error',
      runtime: 'Browser runtime error',
      server: 'Server error',
      network: 'Network error',
      cancelled: 'Cancelled',
      unknown: 'Unknown error',
    },
    result: {
      succeededTitle: 'Result',
      failedTitle: 'Execution failed',
      cancelledTitle: 'Execution cancelled',
      finalRoute: 'Executed on',
      route: { browser: 'browser sandbox', server: 'server (fallback)' },
      cache: { hit: 'cache hit', miss: 'cache miss' },
      duration: 'Total time',
      attemptsHeading: 'Attempts',
      attempt: 'Attempt',
      attemptKind: { browser: 'Browser attempt', server: 'Server fallback' },
      attemptOutcome: { running: 'running…', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown' },
      diagnosticsUnknown: 'Diagnostics unavailable (unknown).',
      code: 'Error code',
      inputHint: 'Fix the highlighted fields and try again.',
      functionHint: 'The function code threw an error.',
      runtimeHint: 'The browser sandbox could not execute the function.',
      serverHint: 'The server-side fallback failed.',
      networkHint: 'Could not reach the unzen server. Check that it is running and reachable.',
      cancelledHint: 'The run was cancelled by you. No server fallback was attempted.',
      unknownHint: 'Unexpected failure.',
    },
    errors: {
      required: 'This field is required.',
      requiredNumber: 'Enter a valid number (got "{value}").',
      integerNumber: 'Enter a non-negative whole number.',
      invalidArrayTokens: 'Invalid token(s) at position {positions}: {tokens}',
      invalidJson: 'Invalid JSON at line {line}, column {column}: {message}',
      priceItemsShape: 'Items must be an array of objects: {detail}',
      discountShape: 'Discount must look like {"type":"percentage","value":10}: {detail}',
      invalidEmail: 'Enter a valid email address.',
      invalidCard: 'Enter a 13–19 digit card number. Fictional sample: 4111 1111 1111 1111.',
      invalidPhone: 'Enter a valid phone number, e.g. +1-555-123-4567.',
      weakPassword: 'Password must be at least 8 characters.',
    },
    stats: {
      heading: 'Session statistics',
      note: 'Counted in this browser tab only. Values reset on reload or when you press Reset.',
      definitions: 'Definitions',
      sampleCount: 'n={count}',
      browserSuccess: 'Browser success',
      fallbackSuccess: 'Fallback success',
      inputError: 'Input error',
      functionError: 'Function error',
      runtimeError: 'Runtime error',
      serverError: 'Server error',
      networkError: 'Network error',
      cancelled: 'Cancelled',
      cacheHit: 'Cache hit',
      unknown: 'Unknown',
      avgTotal: 'Avg total time',
      avgBrowser: 'Avg browser attempt',
      avgServer: 'Avg server attempt',
      definitionBrowserSuccess: 'A function finished in the browser sandbox without server fallback.',
      definitionFallbackSuccess: 'The browser attempt failed and the server produced the result.',
      definitionInputError: 'Input was rejected before execution by this demo\u2019s validation.',
      definitionFunctionError: 'The function code threw an error.',
      definitionRuntimeError: 'The browser sandbox itself failed to execute (e.g. a Wasm/worker problem).',
      definitionServerError: 'The server-side fallback failed.',
      definitionNetworkError: 'Could not reach the server (manifest/code fetch or fallback HTTP request).',
      definitionCancelled: 'The user cancelled the run.',
      definitionCacheHit: 'The manifest was already cached in this session.',
      definitionUnknown: 'Unexpected / unclassified outcome.',
      definitionAvgTotal: 'Mean wall-clock time per completed execution. Sample count shown.',
      definitionAvgBrowser: 'Mean duration of browser attempts. Sample count shown.',
      definitionAvgServer: 'Mean duration of server fallback attempts. Sample count shown.',
    },
    demos: {
      spam: {
        title: '1. Spam Detection',
        description: 'Detect spam keywords in text with a regex-based function.',
      },
      multiply: {
        title: '2. Multiply Numbers',
        description: 'Multiply two numbers in the sandbox.',
      },
      array: {
        title: '3. Double Array Values',
        description: 'Double each element of a comma-separated number list. Invalid tokens are flagged, not dropped.',
      },
      user: {
        title: '4. User Info Transformer',
        description: 'Build a display profile from name and age.',
      },
      form: {
        title: '5. Form Validation',
        description: 'Email, credit card (Luhn), phone and password checks run inside the sandbox.',
      },
      price: {
        title: '6. Price Calculator',
        description: 'Subtotal, discount, tax and shipping are computed in the sandbox. Tax rates: JP 10%, US-CA 7.25%, US-NY 8%, EU-DE 19%, EU-FR 20%, GB 20%.',
      },
      markdown: {
        title: '7. Markdown to HTML',
        description: 'Render Markdown to HTML in the sandbox. The preview is shown in a sandboxed iframe (scripts disabled).',
      },
      text: {
        title: '8. Text Statistics',
        description: 'Word count, sentence count and a Flesch–Kincaid grade level.',
      },
    },
    labels: {
      spamText: 'Text to check for spam',
      num1: 'First number',
      num2: 'Second number',
      arrayInput: 'Numbers, comma-separated',
      firstName: 'First name',
      lastName: 'Last name',
      age: 'Age',
      email: 'Email (fictional sample)',
      card: 'Credit card (fictional sample)',
      phone: 'Phone (fictional sample)',
      password: 'Password (fictional sample)',
      priceItems: 'Items (JSON array of {name, price, quantity, weight?})',
      priceRegion: 'Region (e.g. JP, US-CA)',
      priceDiscount: 'Discount (JSON, optional — {"type":"percentage","value":10})',
      markdownInput: 'Markdown',
      textInput: 'Text to analyze',
    },
  },

  ja: {
    common: {
      title: 'unzen core E2E Demo',
      subtitle: '登録済みの関数をブラウザ内のサンドボックスで実行し、失敗時はサーバーへ自動フォールバックします。',
      demoNotice: 'これはデモです。本番システムではなく、本番品質の保証はありません。所要時間や統計はこのセッション内での実測値で、再読み込みでリセットされます。',
      howItWorksHeading: '動作の仕組み',
      howItWorks: {
        item1: 'まずブラウザで実行: マニフェストと関数ソースを取得し、Web Worker 内の WebAssembly 上の QuickJS インタープリタで実行します(ページのメインスレッドからは分離)。',
        item2: '自動フォールバック: ブラウザ実行が失敗(ランタイムエラー等)した場合、同じ関数をサーバー側で実行します。',
        item3: 'キャンセルはあなたの操作: キャンセルすると即座に中断し、サーバーフォールバックは実行されません。',
      },
      securityHeading: 'セキュリティ境界(このデモが実際に示すこと)',
      securityNote: 'サンドボックスは未検証の関数コードをページから隔離します: 別の Web Worker スレッド内の QuickJS インタープリタで実行し、eval/Function/Proxy を除去し、ビルトインプロトタイプを凍結します。これにより関数コードからページを保護します。ただし、サーバー側の信頼境界・CSP・認証の代替にはなりません。',
      languageLabel: '言語',
      reset: 'すべてリセット',
      run: '実行',
      cancel: 'キャンセル',
      retry: '再実行',
      loadSample: 'サンプルを読み込む',
      executing: '実行中…',
      ready: '準備完了',
      sampleNote: 'サンプルデータは架空のものです。実際のクレジットカード番号・電話番号・パスワードを入力しないでください。',
    },
    states: {
      idle: '準備完了',
      validating: '入力チェック中…',
      preparing: '準備中(マニフェスト・コード取得中)…',
      'running-in-browser': 'ブラウザサンドボックスで実行中…',
      'falling-back-to-server': 'ブラウザ実行が失敗 — サーバーへフォールバック中…',
      'running-on-server': 'サーバーで実行中…',
      succeeded: '成功',
      failed: '失敗',
      cancelling: 'キャンセル中…',
      cancelled: 'キャンセル済み',
    },
    errorCategories: {
      input: '入力エラー',
      function: '関数エラー',
      runtime: 'ブラウザ実行時エラー',
      server: 'サーバーエラー',
      network: 'ネットワークエラー',
      cancelled: 'キャンセル',
      unknown: '不明なエラー',
    },
    result: {
      succeededTitle: '結果',
      failedTitle: '実行に失敗しました',
      cancelledTitle: '実行はキャンセルされました',
      finalRoute: '実行場所',
      route: { browser: 'ブラウザサンドボックス', server: 'サーバー(フォールバック)' },
      cache: { hit: 'キャッシュヒット', miss: 'キャッシュミス' },
      duration: '総所要時間',
      attemptsHeading: '試行履歴',
      attempt: '試行',
      attemptKind: { browser: 'ブラウザ試行', server: 'サーバーフォールバック' },
      attemptOutcome: { running: '実行中…', succeeded: '成功', failed: '失敗', cancelled: 'キャンセル', unknown: '不明' },
      diagnosticsUnknown: '診断情報が取得できません(不明)。',
      code: 'エラーコード',
      inputHint: '強調表示されたフィールドを修正して再実行してください。',
      functionHint: '関数コードがエラーを送出しました。',
      runtimeHint: 'ブラウザサンドボックスで関数を実行できませんでした。',
      serverHint: 'サーバー側フォールバックが失敗しました。',
      networkHint: 'unzen サーバーに接続できません。サーバーの起動と到達性を確認してください。',
      cancelledHint: '実行はあなたがキャンセルしました。サーバーフォールバックは試行されませんでした。',
      unknownHint: '想定外の失敗です。',
    },
    errors: {
      required: 'この項目は必須です。',
      requiredNumber: '有効な数値を入力してください(入力値: "{value}")。',
      integerNumber: '0 以上の整数を入力してください。',
      invalidArrayTokens: '不正なトークン: {positions} 番目 — {tokens}',
      invalidJson: '{line} 行目 {column} 桁目に不正な JSON: {message}',
      priceItemsShape: 'items はオブジェクトの配列である必要があります: {detail}',
      discountShape: 'discount は {"type":"percentage","value":10} のような形にしてください: {detail}',
      invalidEmail: '有効なメールアドレスを入力してください。',
      invalidCard: '13〜19 桁のカード番号を入力してください。架空サンプル: 4111 1111 1111 1111。',
      invalidPhone: '有効な電話番号を入力してください(例: +1-555-123-4567)。',
      weakPassword: 'パスワードは 8 文字以上にしてください。',
    },
    stats: {
      heading: 'セッション統計',
      note: 'このブラウザタブ内でのみカウントされます。再読み込みまたはリセットで初期化されます。',
      definitions: '定義',
      sampleCount: 'n={count}',
      browserSuccess: 'ブラウザ実行成功',
      fallbackSuccess: 'フォールバック成功',
      inputError: '入力エラー',
      functionError: '関数エラー',
      runtimeError: '実行時エラー',
      serverError: 'サーバーエラー',
      networkError: 'ネットワークエラー',
      cancelled: 'キャンセル',
      cacheHit: 'キャッシュヒット',
      unknown: '不明',
      avgTotal: '平均 総所要時間',
      avgBrowser: '平均 ブラウザ試行',
      avgServer: '平均 サーバー試行',
      definitionBrowserSuccess: 'サーバーフォールバックなしでブラウザサンドボックスで完了した回数。',
      definitionFallbackSuccess: 'ブラウザ試行が失敗し、サーバーが結果を返した回数。',
      definitionInputError: '実行前にこのデモの検証で入力が拒否された回数。',
      definitionFunctionError: '関数コードがエラーを送出した回数。',
      definitionRuntimeError: 'ブラウザサンドボックス自体の実行失敗(Wasm/ワーカー問題など)。',
      definitionServerError: 'サーバー側フォールバックが失敗した回数。',
      definitionNetworkError: 'サーバーに到達できなかった回数(マニフェスト/コード取得・フォールバック HTTP)。',
      definitionCancelled: 'ユーザーが実行をキャンセルした回数。',
      definitionCacheHit: 'マニフェストがセッション内で既にキャッシュされていた回数。',
      definitionUnknown: '想定外・分類不能の結果の回数。',
      definitionAvgTotal: '完了した実行の平均壁時計時間。サンプル数付き。',
      definitionAvgBrowser: 'ブラウザ試行の平均所要時間。サンプル数付き。',
      definitionAvgServer: 'サーバーフォールバック試行の平均所要時間。サンプル数付き。',
    },
    demos: {
      spam: {
        title: '1. スパム判定',
        description: '正規表現ベースの関数でテキストのスパムキーワードを検出します。',
      },
      multiply: {
        title: '2. 数値の乗算',
        description: 'サンドボックス内で 2 つの数値を乗算します。',
      },
      array: {
        title: '3. 配列の倍化',
        description: 'カンマ区切りの数値リストの各要素を 2 倍にします。不正なトークンは除外せずに位置を表示します。',
      },
      user: {
        title: '4. ユーザー情報変換',
        description: '名前と年齢から表示用プロフィールを生成します。',
      },
      form: {
        title: '5. フォーム検証',
        description: 'メール・クレジットカード(Luhn)・電話・パスワードのチェックをサンドボックス内で実行します。',
      },
      price: {
        title: '6. 価格計算',
        description: '小計・割引・税・送料をサンドボックス内で計算します。税率: JP 10%、US-CA 7.25%、US-NY 8%、EU-DE 19%、EU-FR 20%、GB 20%。',
      },
      markdown: {
        title: '7. Markdown → HTML',
        description: 'Markdown をサンドボックス内で HTML に変換します。プレビューはサンドボックス化された iframe(スクリプト無効)に表示します。',
      },
      text: {
        title: '8. テキスト統計',
        description: '単語数・文数・Flesch–Kincaid グレードレベルを算出します。',
      },
    },
    labels: {
      spamText: 'スパム判定するテキスト',
      num1: '数値 1',
      num2: '数値 2',
      arrayInput: '数値(カンマ区切り)',
      firstName: '名',
      lastName: '姓',
      age: '年齢',
      email: 'メール(架空サンプル)',
      card: 'クレジットカード(架空サンプル)',
      phone: '電話番号(架空サンプル)',
      password: 'パスワード(架空サンプル)',
      priceItems: '商品(JSON 配列 {name, price, quantity, weight?})',
      priceRegion: 'リージョン(例: JP, US-CA)',
      priceDiscount: '割引(JSON、任意 — {"type":"percentage","value":10})',
      markdownInput: 'Markdown',
      textInput: '解析するテキスト',
    },
  },
};

/** Flatten a nested dictionary into `{ 'a.b.c': value }` paths. */
export function flattenKeys(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenKeys(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/**
 * Create a `t(key, params)` lookup for a language. Unknown languages and
 * unknown keys fall back gracefully (never throw).
 */
export function makeI18n(lang) {
  const resolved = LANGUAGES.includes(lang) ? lang : 'en';
  const dict = messages[resolved] || messages.en;
  const flat = flattenKeys(dict);
  return {
    lang: resolved,
    t(key, params = {}) {
      const template = flat[key];
      if (template === undefined || template === null) return `[${key}]`;
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    },
  };
}
