# bg-watch

[English](README.md) | 繁體中文

一個 Claude Code mod，即時顯示在 prompt 上方的 band、側邊 pane，以及對話紀錄裡每個工具呼叫的下方：

- 背景執行的 Bash 指令、Monitor 與 Workflow：進度、失敗數量、最後一行輸出、已執行時間、
  長時間無輸出的警告，以及結束方式（含 exit code）
- 每個子代理實際送出的 model@effort（以及主代理的），附上輸出 token 數與花費

## 畫面示意

### prompt 上方的 band

有工作在執行時，這一行會統計工作與 agent 數量，並列出一個執行中的工作（有進度的優先，否則取執行最久的）：

```
bg ▶3 jobs  ✗1 failed  ?1  ▶2 agents │ ▶ Full e2e suite · 41/262 ×1 9m02s  [open]
❯ _
```

全部結束後，會變成灰色的 session 統計，不會一直停留在最後一個工作：

```
bg idle · jobs ✓5 ✗1 ■1 · 10 agents done · last activity 3m12s ago  [open]
❯ _
```

還沒有任何工作執行過時，band 不佔列。點這一行開啟 pane，再點一次關閉。Claude Code 本身提供的 `[-]`
可以收合 band。

### pane

可停靠在對話紀錄旁（dock），或顯示在 prompt 上方（inline）。每列固定一行，依 pane 寬度排版；
拖曳 pane 邊緣調整大小後會自動重排。

```
▾ Jobs  ▶2 ✓4 ✗1 ?1                     [clear]  [x]
▸ ▶ Full e2e suite          41/262  ×1  9m02s
▾ ▶ Rerun mutation check     no output yet  9m44s
    cmd   npm run mutation -- --site tw,hk,sg
    out   /tmp/claude-1000/…/tasks/b9m4.output
    start 9m44s ago
    [stop]  [copy path]
▸ ? Implement #1495 tests   no output file  45m00s
  ▸ done 6  ✓4 ✗1 ■1

▾ Agents  ▶2                main opus-5-5@med
▸ ▶ dhpk:security-reviewer  Security review…  opus-5-5@high  53 st  21m16s
▸ ▶ general-purpose  Diagnose workflow…  sonnet-5-5@med  159 st  45m02s
  ▸ done 10
```

沒有任何工作執行時，pane 頂端先顯示目前狀態與本 session 統計：

```
Idle · nothing running
session  jobs ✓5 ✗1 ■1 · agents 10 · last 3m12s ago
```

### 可點擊的地方

| 位置 | 點擊 | 作用 |
| --- | --- | --- |
| band | 整行 | 開啟或關閉 pane |
| pane | 工作或 agent 列 | 展開或收合細節 |
| pane | `Jobs`、`Agents`、`done N` | 收合或展開該組（已結束的組別預設收合） |
| 工作細節 | `[stop]` | 透過 TaskStop 停止該工作 |
| 工作細節 | `[copy path]` | 複製輸出檔路徑 |
| agent 細節 | `[view transcript]` | 把該 agent 的對話切到主畫面 |
| pane 頂端 | `← back to main` | 回到主對話 |
| pane 標題列 | `[clear]` | 清除已結束的列（session 統計仍會計入） |
| pane 標題列 | `[x]` | 關閉 pane |

### 圖例

| 標記 | 狀態 | 顏色 |
| --- | --- | --- |
| `▶` | 執行中（工作，或仍存活的 agent） | 強調色 |
| `✓` | 完成 | 綠 |
| `✗` | 失敗，附 exit code | 紅 |
| `■` | 已停止：`killed`、`stopped`、`ended`（未收到通知就結束）、`expired`（Monitor 超過 timeout） | 灰 |
| `?` | 狀態不明：始終找不到輸出檔的 Bash 工作，不計入執行中 | 黃 |
| `·` | 已結束的 agent | 灰 |
| `▸` / `▾` | 收合 / 展開的列或組別 | |
| `×N` | 目前看到的失敗數（TAP `not ok`，或測試工具摘要中的數字） | |

## 指令

| 指令 | 作用 |
| --- | --- |
| `/bg-watch` | 開啟 pane |
| `/bg-watch close` | 關閉 pane |
| `/bg-watch clear` | 立即清除已結束的列 |

## 讀取哪些資訊

進度依以下順序判斷，越具體的格式越優先：TAP 計畫（`1..N` 搭配 `ok` / `not ok` 行）、jest 或 vitest 的
`Tests:` 摘要、pytest 的 `[ 45%]`、行尾的百分比，最後才是單獨出現的 `N/M`（像 `2026/11/18` 這類日期或
`src/1/2` 這類路徑會被略過）。最後一行輸出中的 ANSI 色碼會被移除。

工作在以下情況視為結束：收到 task notification、被 TaskStop 停止，或是：

- 沒有收到通知的 Bash 工作（子代理啟動的工作、漏掉的通知）：輸出安靜一段時間後，若 `lsof` 顯示已沒有程序
  開著輸出檔，就標示為 `■ ended`（exit code 未知）
- Monitor：超過它自己的 timeout 後，標示為 `■ expired`

始終找不到輸出檔的 Bash 工作，超過 `staleSec` 後標示為 `? unknown`，不計入執行中；收到通知時仍會正常結束，
超過 `finishedTtlSec` 也會自動結束。已結束的工作與閒置的子代理列，經過一段時間後會自動從 pane 移除。
執行時間較長的工作結束時，會發出系統通知。

## 設定

在 `/config` 中調整，或寫在 settings.json 的 `pluginConfigs["bg-watch"].options`：

| 欄位 | 預設值 | 說明 |
| --- | --- | --- |
| `finishedTtlSec` | 1800 | 已結束的工作或閒置子代理列保留在 `done` 之下的秒數 |
| `quietCheckSec` | 10 | 輸出安靜超過此秒數後，用 `lsof` 檢查 Bash 工作是否已結束 |
| `staleSec` | 60 | 執行中工作的輸出超過此秒數沒有增加，就顯示 `quiet …` |
| `notifyAfterSec` | 120 | 執行超過此秒數的工作結束時發出系統通知；設為 `0` 關閉 |
| `band` | true | prompt 上方可點擊的摘要列 |
| `statusLine` | false | 另外在狀態列顯示執行中的工作 |

## 安裝

在終端機的 Claude Code session 提示字元輸入：

```
/plugin install bg-watch --marketplace hmj1026/bg-watch
```

詢問是否新增 marketplace 時回答 `y`，再選擇安裝範圍。

或在 shell 中執行：

```bash
claude plugin marketplace add hmj1026/bg-watch
claude plugin install bg-watch@bg-watch            # 加上 -s project 或 -s local 可改變安裝範圍
```

重新啟動 Claude Code（或開新的 session），再輸入 `/bg-watch` 開啟 pane。

## 更新

先更新 marketplace，再更新 plugin，然後重新啟動 Claude Code 以載入新版本：

```bash
claude plugin marketplace update bg-watch
claude plugin update bg-watch@bg-watch
```

在 session 中輸入 `/plugin` 也能開啟同樣的 marketplace 與 plugin 管理介面。`claude plugin list`
可查看目前安裝的版本。

## 移除

```bash
claude plugin uninstall bg-watch@bg-watch
claude plugin marketplace remove bg-watch          # 選用：一併移除 marketplace
```

## 開發

```bash
claude --plugin-dir ~/projects/bg-watch            # 載入工作目錄版本開啟 session
claude plugin test .                               # 執行測試
claude plugin validate .                           # 檢查 manifest 與 hooks module
```
