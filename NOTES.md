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
