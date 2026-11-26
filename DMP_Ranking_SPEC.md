# DMPランキング自動集計アプリ 実装仕様書

## 1. 目的と実装指示
新規独立リポジトリとして、公式ランキングと大会結果から独自計算した暫定ランキングを比較・閲覧するブラウザアプリを実装する。Node.js / Express / HTML / CSS / JavaScript / PostgreSQL、Render Free、Neon Free、GitHub、VS Codeを使用。月額0円を目標とし、有料サービスを無断で有効化しない。既存母数集計アプリのコードは利用可能な場合のみ参考にし、既存DBやサービスを変更しない。全機能を一括依頼するが、段階ごとにテストし、未検証事項を推測で確定しない。サイト名は仮称DMP Ranking Tracker。

## 2. データ取得契約
すべて日本時間（Asia/Tokyo）。HTTPタイムアウト、レスポンス形式検証、リトライ、文字コード処理を実装。公開データのみ使用し、ログインCookieや個人認証情報を使用しない。利用規約・自動取得・再公開の許容範囲を公開前に確認し、許可が不明な場合は実データ自動取得を停止可能にする。

### 2.1 大会一覧
POST https://www.dmp-ranking.com/schedule.asp （application/x-www-form-urlencoded）。検証例：`Mode=Result&Search=Search&Grade=CS&EventFrom=2026%2F11%2F19&EventTo=2026%2F11%2F25&EventDendo=&Meisho=&JudgeMei=&Pref1=&Pref2=&Pref3=&Venue=`。Shift_JIS/CP932をiconv-lite等で処理し、table#mainの行とonclickのresult.asp?ShopID=...&EventID=...&Seq=...を解析。開催日、名称、都道府県、店舗、形式、個人/チーム、倍率、承認状態を保存。倍率空欄は未登録、非空欄（×0含む）は結果登録検知。倍率不変でも修正はあり得る。開催年+店舗ID+大会ID+開催IDで識別。

Grade: CS=通常CS、CSE=超CS、GP=GP、BN=日本一。NQ=店舗予選、AR=エリア、OL=リモート、ORG=ファンは0ptとして取得対象外。日本一の別枠加算はポイントが付与される場合のみ。開催予定の取得方法は実機で検証する。

### 2.2 大会結果
POST https://www.dmp-ranking.com/Deckbuild/Event/EventResult.aspx/GetResultRanking
Content-Type: application/json; charset=UTF-8
```json
{"year":"2026/11/13 0:00:00","shopID":"4253","eventID":"351","heldID":"2","offset":120}
```
`year`は開催日を含む文字列。応答は外側JSONのdにJSON文字列が入る。店舗ID、大会ID、開催ID、成績ID、順位、会員ID、ポイントID、集計対象、最終更新日時、ハンドルネーム、全国順位、都道府県順位、都道府県名、エリア順位、エリア名、順位ポイント、ジャッジ加算、ジャッジ人数等。会員IDをDMP IDとして使用。順位pt+ジャッジ加算が獲得pt。空欄ptは0として計算するが欠損と区別できるようにする。集計対象は独自集計の条件にしない。

ページングはoffset=0,30,60...。返却件数でoffsetを増やさない。短いページ、0ptページは終了条件にしない。通常CSは正常な空配列まで取得する。大規模大会は付与範囲と順序が検証できた場合のみ短縮し、未検証なら全ページ取得。安全上限に達した場合は不完全として再開し、成功扱いしない。全ページでも0pt参加者が省略される可能性がある。完全な参加者数と混同しない。成績削除は取得範囲の完全性が確認された場合のみ。

検証例：80人CS shop2951/event351/held1 2026-11-22、offset 0/30/60/90で30/3/1/0件、32人がpt獲得。6.6倍CS shop4253/event351/held2 2026-11-13、offset90/120/150/180で30/9/1/1件、121〜128位は110+22=132pt、129位以降のサンプルは空欄pt。GP shop3954/event359/held1 2026-11-15、offset240で17件（16人150pt）、270/300で各1件0pt。128位が通常CS全体の上限とは未確認。GPの256位も検証例であり固定しない。倍率別付与範囲は管理者設定可能にする。チーム戦APIの選手単位返却と重複を実機検証する。

### 2.3 公式ランキング
POST https://www.dmp-ranking.com/Deckbuild/Event/Ranking.aspx/GetRanking
```json
{"_term":"20262","_region":"0","_type":-1,"_rank":"0"}
```
会員ID、HN、ポイント、全国順位、地域情報を保存。全国上位約1000人の取得例。パラメータの意味・ページ範囲・同順位境界を追加検証。公式集計日時は旧ページ https://www.dmp-ranking.com/ranking.asp?HyojiNendo=20262&Pref=0 の「前回集計日時：2026/11/18 15:01:58」等をCP932で解析。旧ページの期コードと新APIの期コードを同一と仮定しない。更新日時が変化したら公式ランキング取得、整合性確認、スナップショット保存。取得中に公式更新が発生した場合は再確認する。

### 2.4 個人成績
POST https://www.dmp-ranking.com/userresult.asp のフォーム例 `UserID=%82%E9%82%C8%82%A9%82%B7&HyojiNendo=20262&Pref=0&RankingMode=&Range=1`。UserIDは最新HNをCP932でURLエンコードした値。table#result、日付、大会名、順位、pt、onclickの大会キー、黄色行（style color:#ffff00）を解析。黄色は公式側の集計対象の参考値。ユーザー確認では完全同一HNは登録不可。内部識別は常にDMP ID、HN変更を追跡し、大会結果との照合が可能なら行う。照合不能は保留。個人成績のポイントは合計値として扱い、内訳不明ならNULLを保持。APIで補完しても二重計上しない。初期追跡者と新規追跡者の当期全履歴を取得。取得対象期を日付で検証する。

## 3. 集計・追跡
- 通常CSは月曜〜日曜の週内で個人戦・チーム戦を合算し獲得pt上位2大会のみ採用。超CS・GP・日本一は別枠加算。その他0pt。ジャッジ加算のみで獲得するケースはないというユーザー確認。週と期の境界、同点時の採用順（安定した大会キー等）は検証し明文化。期ごとに管理者がルールを設定できる。
- 当期全成績を独自集計し、公式更新で独自データを上書きしない。変更された選手・週を優先再計算。公式集計対象と独自対象は別フラグ。採用された成績を黄色表示。
- 初期は公式上位200位（同順位含む）を追跡。公式ランキング全取得分を保存。初期個人成績取得完了・検証後に暫定ランキング公開。進捗と再開機能を提供。
- 以降は全国大会結果を取得し全取得可能な成績を保存。公式上位200、暫定上位200、上位200入りの可能性がある候補、ウォッチリスト、管理者指定を追跡。公式pt+新規獲得pt等の上界で候補判定し、候補は当期個人成績を補完。公式取得範囲外の選手や修正により上界が不明な場合は網羅性を保証しない。追跡解除しても成績は保持し再登録時補完。
- 公式更新時に追跡対象を再評価。ウォッチリストはブラウザLocalStorage、サーバー側はDMP ID単位で重複排除。30日利用なしで一般ウォッチ由来の追跡を停止、管理者・ランキング由来は除外。登録制限を設ける。
- 暫定順位は競技順位（98,99,99,101）、同点表示順は公式順位→DMP ID。ボーダーはソート後n人目のpt。追跡外選手を含む正確な全国順位とは表示しない。
- 公式集計時点と比較可能な独自値を照合し、不一致は個人成績再取得、未解決は管理画面へ。公式値で強制修正しない。集計時点の再現不能は不明として区別。通常更新の部分失敗時は旧値・取得不足を明示、新規未初期化者は順位対象外。ボーダーの不確実性も表示。
- 期切替時は前期上位200+ウォッチリストを引き継ぎ、初回公式更新までは新期pt獲得者も対象にする。過去期の閲覧・比較を提供。運用開始以前の順位推移を捏造しない。

## 4. 定期処理
日本時間00:00〜11:59は毎時、12:00〜15:59は30分ごと、16:00〜23:59は10分ごと（計68回/日）。CS一覧の当日〜7日前はこの頻度、8〜14日前は毎日、15〜30日前は週1、31日以上は公式更新時に整合性確認。CSE/GP/BNは通常毎日、開催日〜結果登録までは高頻度。登録済み結果の修正確認は初回検知から24h未満毎時、24〜72hは6時間ごと、それ以降毎日、公式反映確認後は通常再取得停止。ただし次回公式更新で不一致が出た場合や手動指示時に再取得。
公式更新日時確認は水曜以外1日1回、水曜00〜12時毎時、12〜15時30分、15〜18時5分、18〜24時15分を初期案とする。水曜の更新後も再更新検知用の低頻度確認を残す（安全側の実装案）。設定変更可能。
cron-job.orgを第一候補とし、認証付きPOSTで永続キュー登録、速やかに応答。Renderコールドスタート・30秒制限・停止時再開を実機検証。失敗時の代替スケジューラを検討。常時pingで無料枠を浪費しない。Webと取得処理を分離可能な構造。ジョブ重複防止、DBロック/リース、チェックポイント、期限切れ再開、原子的な結果反映。初期並列2、リクエスト開始間隔1秒以上、429/Retry-Afterを尊重。失敗後1/5/15分で再試行、4回失敗で対象処理停止、毎時回復確認、復旧時補完。優先度は公式/新規結果→修正/新規選手→差分/履歴。実行時間・取得件数・通信量を記録。停止・再開可能。

## 5. DB設計
PostgreSQL、マイグレーション管理。以下20テーブルを基本とし必要なら追加・統合し理由を記録。日時TIMESTAMPTZ、開催日DATE、倍率NUMERIC、pt整数、内部ID BIGINT、DMP ID整数（範囲検証）。FK、UNIQUE、CHECK、適切な複合インデックス。秘密情報は環境変数、パラメータ化SQL。

| テーブル | 主な項目・制約 |
|---|---|
| players | dmp_id PK, handle_name, prefecture, region, created_at, updated_at |
| player_name_history | dmp_id, name, observed_at |
| seasons | id, source_term, starts_on, ends_on, finalized_at, compacted_at |
| aggregation_rules | season_id, version, weekly_limit, grade_rules, effective_at |
| events | id, season_id, event_year, shop_id, source_event_id, held_id, event_date, event_name, grade, prefecture, is_team, multiplier, result_status, first_detected_at, result_registered_at, last_fetched_at, next_fetch_at, result_hash; UNIQUE(event_year,shop_id,source_event_id,held_id) |
| event_results | id, event_id, dmp_id, source_result_id, placement, rank_points, judge_bonus, total_points, official_counted, provisional_counted, source_updated_at, updated_at, active, source/coverage; UNIQUE(event_id,dmp_id)（チーム戦検証） |
| event_result_changes | id, event_result_id, changed_fields JSONB（変更前後）, detected_at, source_updated_at; 取消も記録 |
| official_rankings | season_id,dmp_id,rank,points,aggregation_at; 最新値 |
| official_history | snapshot_id/aggregation_at, season_id,dmp_id,rank,points; 更新ごとに全取得分 |
| weekly_points | season_id,dmp_id,week_start,weekly_counted_points,extra_points,total_points,rule_version |
| provisional_rankings | season_id,dmp_id,rank,points,coverage,status,calculated_at |
| provisional_history | season_id,dmp_id,rank,points,tracked,status,batch_id,observed_at; 変動時のみ。日次圧縮行の最終順位・pt、最高/最低順位、状態も保持可能にする |
| tracked_players | season_id,dmp_id,reason(s),active,last_requested_at,backfill_status |
| fetch_jobs | type,payload,dedupe_key,priority,status,attempts,next_run_at,lease_until,checkpoint |
| fetch_logs | job_id, status, bytes, duration,error,created_at |
| sync_discrepancies | season_id,dmp_id,aggregation_at,official_points,computed_points,status,details |
| app_settings | key,value,updated_at |
| admin_accounts | id,login,password_hash,role |
| admin_sessions | session_hash,admin_id,expires_at |
| backup_history | created_at,status,storage_reference,checksum |

ボーダー専用保存テーブルは作らず履歴から算出する。変動履歴は集計バッチ単位で時点復元可能にし、追跡追加/解除、初期値、欠損状態も記録する。日次圧縮は日本時間の日末の共通時点で全対象者を復元し、各人の最終順位/ptと最高/最低順位を保存する。最終公式ランキング確定（管理者指定可）から30日後、バックアップ・復元検証後に詳細履歴を圧縮。公式履歴、大会成績、修正差分は永久保持方針。通常ログ30日、エラー90日。週次バックアップ直近4回、手動export/restore。保存先は未選定、無料の外部ストレージを確認し、未設定時は未実施と表示。容量70%警告、80%安全な整理、90%低優先履歴停止、95%増加制限を初期設定案とし重要データを自動削除しない。

## 6. UIと機能
スマホ優先、情報密度重視、装飾を抑える。上昇緑、下降赤、有効pt黄色、非採用灰色。アクセシビリティ（色以外の記号、キーボード、コントラスト）。一般アカウントなし、LocalStorage設定。URL限定公開、noindex（アクセス制限ではない）。
- ランキング：暫定（初期）/公式タブ。暫定順位、HN、pt、公式順位/pt、順位差、pt差、週間pt、追跡状態。50/100/200/全追跡表示、初期100。同順位境界は全員表示。全対象をソートしてから表示制限。各指標昇降順、検索HN部分一致/DMP ID。公式保存全範囲検索、追跡外は公式のみ表示しウォッチ追加可能。
- 更新状態：公式/暫定最終成功、次回予定、大会の反映済/登録済未反映/未登録数（開催済のみ）。ブラウザ前面時のみ1分ごとに自サーバーの軽量バージョン確認、変更時のみデータ取得。復帰時・手動更新。スクロール/条件維持。DMP直接アクセスを誘発しない。キャッシュ活用。
- 選手詳細：公式/暫定順位pt、順位pt推移、週間成績、採用のみ切替、全期/月/週/任意日付フィルタ。期間フィルタで採用判定を変えない。参加数、週間平均、1大会平均、優勝/上位回数。0pt欠損時は取得済み範囲の値として表示。週間pt棒グラフ、目標、未完了週を平均から除外する初期案。ボーダー差、手動目標pt、必要週間平均、現在ペースでの期末個人pt予測（ボーダー予測ではない）。
- ボーダー：任意1〜200位、初期100、プリセット、公式/暫定差、推移グラフ、過去期比較。設定LocalStorage。対象不足なら未確定。
- 大会：日付/都道府県/種別/状態/名称検索、倍率、公式リンク、ポイント獲得者、追跡者強調、取得範囲表示。
- ウォッチリスト：星で追加解除、専用ページ、順位外も追跡。設定ページ、過去期切替。スマホ下部ナビを初期案とする。地域別ランキングは今回対象外。バグ報告機能なし。
- 管理：認証、追跡者管理、個人/大会再取得、手動再計算、停止再開、スケジュール/ルール/倍率範囲設定、ジョブ/ログ/差分/通信量/DB容量、バックアップ、期確定、初期化進捗。

## 7. API・セキュリティ
内部APIの具体的なルート名は実装者が設計し文書化。公開読み取りAPIと管理/cron更新APIを分離。入力検証、レート制限、CSRF、CSP、XSS対策、セキュアCookie、パスワードscrypt等、セッションハッシュ、秘密情報ログ除外。cron認証は秘密ヘッダー等を使用しURLに秘密を含めない。任意URL取得を許さず公式ホストを許可リスト化。SQL注入対策。一般ウォッチ登録は上限・重複防止。キャッシュに管理情報を混ぜない。DBトランザクションで整合性を保つ。

## 8. 無料枠・運用
過去試算はRender既存込み675h/月、通信1.15GB/月、Neon年間337MB、60CUh/月、通信1.2GB/月。すべて仮定で保証ではない。無料枠の現行条件を公式資料と実際のダッシュボードで再確認する。Renderの共有稼働時間が最大の懸念。実測・警告・停止設定を用意し、有料移行はユーザー承認必須。DBへの不要な接続、全件読み出し、変更なし書き込みを避ける。無料枠不足時に取得処理を別サービスへ移せるようにする。

## 9. 実装順と受入テスト
1. リポジトリ初期化、README、.env.example、マイグレーション、テスト環境。
2. 取得アダプタと匿名化フィクスチャ、文字コード、ページング、失敗処理。
3. 保存・差分・週間集計・公式同期・追跡・履歴。
4. 永続キュー・定期処理・管理・バックアップ。
5. 公開UI、スマホ、検索、グラフ、設定。
6. 統合テスト、実機検証、デプロイ手順。公開はユーザー確認後。

必須テスト：週内上位2、チーム戦混在、別枠、0pt、同点、期境界、HN変更、重複取得、修正/取消、個人成績とAPIの統合、短いページ/0ptページ/空配列、異常応答、途中失敗と再開、同時ジョブ、429、公式更新競合、追跡追加解除、順位同点、ボーダー復元、日次圧縮と復元、管理権限、cron認証、スマホUI、容量・通信計測。公式上位200について比較可能な同一集計時点の一致率100%を目標とし、比較不能/不一致を別集計、原因を報告。未検証の外部仕様をテスト成功と称さない。自動テスト全件成功、重複0、重大な未解決不具合なしを公開条件とする。

## 10. 未確定事項と報告義務
通常CS最大付与順位、GP等の安全な短縮条件、チーム戦API、期コード/境界、公式集計対象フラグの厳密な意味、公式更新時刻の再現、公式範囲外の候補網羅性、0pt参加者補完、HN検索の範囲外登録方法、バックアップ保存先、cronのコールドスタートと無料枠、利用規約は未検証。実装者は確認結果と残課題を記録し、仕様を勝手に変更しない。重大な判断はユーザーに確認。軽微な内部設計は理由を記録して進める。最終報告には変更ファイル、テーブル、API、テスト件数と結果、実測、起動手順、未実装・未検証事項を含める。Gitコミットや公開環境変更はユーザーの指示に従う。
