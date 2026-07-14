# 今夜の筋メシ 日本語レシピ500件更新版

## 重要

このZIP内の `recipes.json` は空です。
GitHub Actionsが日本の公開レシピページを1件ずつ開き、到達できた500件だけを収録します。
未確認のデータを500件として見せないための仕様です。

## アップロード

ZIPを展開し、中身を `dinner` リポジトリのルートへアップロードしてください。
`.github` と `scripts` フォルダも必要です。

## 実行

1. GitHubの `Settings → Actions → General` を開く
2. `Workflow permissions` を `Read and write permissions` にする
3. `Actions → Build verified Japanese recipes → Run workflow` を押す
4. 完了すると `recipes.json` と `recipes-validation.json` が自動更新される

## 更新方法

料理データだけを変える場合、通常は `recipes.json` だけ差し替えれば反映されます。
確認記録も残す場合は `recipes-validation.json` も一緒に差し替えてください。

## データ仕様

- 日本語の料理名
- 日本語の材料・分量
- 日本語に短く言い換えた手順
- 調理時間
- 筋肉増量・減量・維持の分類
- 出典名、出典URL
- ページ確認日時とHTTP結果
