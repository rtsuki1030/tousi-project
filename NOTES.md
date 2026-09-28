# 作業メモ（2026-09-07〜08）

## 現在の構成

| 場所 | 役割 | URL |
|---|---|---|
| GitHub Pages | 自分で操作するメインアプリ（手動売買・グラフ・タブを開いている間だけ動くAI） | https://rtsuki1030.github.io/tousi-project/ |
| GitHub Pages | サーバー側AIの状況確認（読み取り専用） | https://rtsuki1030.github.io/tousi-project/ai-status.html |
| Cloudflare Workers | サーバー側AIの実行エンジン（別会計のポートフォリオ） | https://tousi-ai-worker.rtsuki1030.workers.dev |
| GitHub Actions | サーバー側AIを5分ごとに叩いて動かすトリガー | リポジトリの Actions タブ「AI trading tick」 |
| GitHub リポジトリ | ソースコード一式 | https://github.com/rtsuki1030/tousi-project |

## できること

- 米国株（Twelve Data）・暗号資産（CoinGecko）の実価格取得と自動売買
- AIが自分で新しい投資先（暗号資産は時価総額上位、株式は主要企業プール）を発見してウォッチリストに追加
- サーバー側AIは、ブラウザを閉じてもPCをスリープさせても24時間自動で動き続ける

## 日次収支レポート

- 毎日21:00（日本時間）に、サーバー側AIの収支をDiscordへ送信（GitHub Actions「Daily P&L report」→ Worker の `/api/daily-report`）
- 「本日の損益」は前回レポート時点の総資産との差。1日1回までしか送らない（再実行しても重複しない）
- 送信先：日次レポートは #shuusi（Worker のシークレット `DISCORD_WEBHOOK_URL`）、週次レポートは #learn（`DISCORD_WEBHOOK_URL_LEARN`、未設定なら #shuusi に送信）
- 送らずに中身だけ確認：`https://tousi-ai-worker.rtsuki1030.workers.dev/api/daily-report?dry=1`
- 毎週日曜21:00には週次レポート（今週の損益・取引・戦略の重みの変化・学んだこと・バックテスト結果）も送信（GitHub Actions「Weekly learning report」→ `/api/weekly-report`、確認は `?dry=1`）

## AIの戦略と学習（エンジンv2）

- 価格を1時間足にまとめ、5つの戦略（モメンタム・移動平均クロス・RSI・ボリンジャーバンド・ブレイクアウト）が毎時「買い/売り/中立」を投票
- 各戦略の票が次の1時間で当たったかで重みを自動調整（当たらない時は「見送り（現金）」の重みが増えて慎重になる）
- 重み付き合議スコアが買い基準以上で購入（1銘柄あたり総資産の10%）、売り基準以下・損切り・利確で売却。手数料（暗号資産0.15%・株0.1%）込みで計算
- 戦略の中身は `worker/src/strategies.js`（本番とバックテストで共通）
- **週1回のバックテスト**（GitHub Actions「Weekly strategy backtest」、月曜3:00）：過去90日の1時間足で、前半60日で設定を選び、後半30日で検証。以前の設定より良い時だけ採用し、`backtest/results/config.json` にコミット → Workerが6時間ごとにGitHubから読み込む
- 手元でも `node backtest/run.mjs` で実行可能。GitHubのリポジトリシークレットに `COINGECKO_API_KEY` を登録すると速くなる（なくても動く）
- バックテストは現在、暗号資産のみ（Twelve Dataの無料枠を本番の株価取得と取り合わないため）

## 既知の制約

- **日本株（4桁コード）は実価格取得に対応していません。** Twelve Data・FCS API・JPX公式のいずれも無料プランでは日本の証券取引所データを提供しておらず、手動入力のみ対応です。
- サーバー側AI（Cloudflare Workers）は、当初 Cloudflare 自身の Cron Trigger 機能で自動実行する予定でしたが、**新規アカウントでcronが登録されても発火しないCloudflare側の既知の不具合**に当たったため、GitHub Actionsの定期実行（5分ごと）で代替しています。
- ブラウザ版・サーバー版のAIはそれぞれ別のデータ（別会計のポートフォリオ）です。
- データはブラウザのlocalStorageに保存されるため、スマホとPCで別のデータになります（設定タブのエクスポート/インポートで手動移行可能）。

## APIキーの管理場所

- Twelve Data APIキー：ブラウザ版アプリの「設定」タブ（localStorage保存）／Cloudflare Workerのシークレット（`wrangler secret put TWELVE_DATA_KEY` で設定済み）
- FCS APIキー：登録はしたが、日本株が無料プラン対象外だったため現在未使用（アプリからは削除済み）

## 次にやるとしたら

- サーバー側AIの初期資金は¥1,000,000（`worker/src/index.js` の `INITIAL_CASH` で変更可能）
- Cloudflareのcron不具合が直った場合、`worker/wrangler.toml` の `[triggers]` は残してあるので、直れば自動的にもう一系統動き出します（実害はなく、頻度が上がるだけ）
