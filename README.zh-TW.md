# bg-watch

[English](README.md) | 繁體中文

一個 Claude Code mod，即時顯示在側邊 pane、對話紀錄裡每個工具呼叫的下方，以及狀態列：

- 背景執行的 Bash 指令、Monitor 與 Workflow：進度、`not ok` 數量、最後一行輸出、已執行時間、
  長時間無輸出的警告，以及結束方式（含 exit code）
- 每個子代理實際送出的 model@effort（以及主代理的），附上輸出 token 數與花費

用 `/bg-watch` 開啟 pane；`/bg-watch close` 關閉；`/bg-watch clear` 立即清除已結束的列。
pane 中每個執行中的工作都有一個 `stop` 按鈕，會透過 TaskStop 停止該工作。

## 讀取哪些資訊

進度依以下順序判斷，越具體的格式越優先：TAP 計畫（`1..N` 搭配 `ok` / `not ok` 行）、jest 或 vitest 的
`Tests:` 摘要、pytest 的 `[ 45%]`、行尾的百分比，最後才是單獨出現的 `N/M`（像 `2026/11/18` 這類日期或
`src/1/2` 這類路徑會被略過）。

工作在以下情況視為結束：收到 task notification、被 TaskStop 停止，或是：

- 沒有收到通知的 Bash 工作（子代理啟動的工作、漏掉的通知）：輸出安靜一段時間後，若 `lsof` 顯示已沒有程序
  開著輸出檔，就標示為 `■ ended`（exit code 未知）
- Monitor：超過它自己的 timeout 後，標示為 `■ expired`

已結束的工作與閒置的子代理列，經過一段時間後會自動從 pane 移除。執行時間較長的工作結束時，會發出系統通知。

## 設定

在 `/config` 中調整，或寫在 settings.json 的 `pluginConfigs["bg-watch"].options`：

| 欄位 | 預設值 | 說明 |
| --- | --- | --- |
| `finishedTtlSec` | 180 | 已結束的工作或閒置子代理列在 pane 中保留的秒數 |
| `quietCheckSec` | 10 | 輸出安靜超過此秒數後，用 `lsof` 檢查 Bash 工作是否已結束 |
| `staleSec` | 60 | 執行中工作的輸出超過此秒數沒有增加，就顯示 `(quiet …)` |
| `notifyAfterSec` | 120 | 執行超過此秒數的工作結束時發出系統通知；設為 `0` 關閉 |
| `statusLine` | true | 在狀態列顯示執行中的工作 |

## 安裝

在終端機的 Claude Code session 提示字元輸入：

```
/plugin install bg-watch --marketplace hmj1026/bg-watch
```

詢問是否新增 marketplace 時回答 `y`，再選擇安裝範圍。
