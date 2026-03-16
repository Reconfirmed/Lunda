[![TypeScript](https://badges.frapsoft.com/typescript/code/typescript-125x28.png?v=101)](https://github.com/ellerbrock/typescript-badges/)

# Lunda

人間と、ついに交響曲を奏でたロボットからの ❤️ を込めて

[English](README.md)

---

Lunda は、長期間更新されていない“放置されたブランチ”を検出するための、軽量でスマートかつフレンドリーな GitHub Action ツールです。
開発者やセキュリティを重視するチームが、メンテナンス上のリスクやセキュリティリスクを引き起こす可能性のある古いブランチを簡単に発見できるよう設計されています。

---

## 🚀 機能

- 任意に設定できるしきい値（日数）に基づいて、非アクティブなブランチを検出  
- main / master などのメインブランチはデフォルトで無視  
- 放置されたブランチを、最終コミット日時とともに一覧表示
- GitHub Action として簡単に統合可能
- Slack / Teams / Email などへの通知や自動クリーンアップなど、拡張が容易
- リポジトリの整理（ハイジーン）と、古いコードによるセキュリティリスクの軽減に役立つ

---

## 🛠️ 使い方

Lunda は公式 GitHub Action として利用可能です。
リポジトリのワークフローに直接組み込むことができます。

### ワークフロー例

```YAML
name: Scan Forgotten Branches

on:
  workflow_dispatch: # 手動実行
  schedule:
    - cron: '0 12 * * 1' # 毎週月曜の12:00

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: your-username/lunda@v1
        with:
          days_threshold: 60 # 任意、デフォルトは90
```

### 入力パラメータ

- days_threshold（任意）ブランチが「非アクティブ」と見なされるまでの日数。デフォルト：90日

Lunda は、このしきい値より長く更新されていないブランチをスキャンし、ワークフローのログに一覧表示します。

---

## ⚙️ スクリプト設定

``` Javascript
    const DAYS_THRESHOLD = 90; // 非アクティブと見なす日数
```

- リポジトリの活動度合いに応じて DAYS_THRESHOLD を調整してください
- main および master ブランチは常に除外されます

---

## 📄 ライセンス

```
MIT License
```
---

あなたのリポジトリに愛と安全を — Lunda より！