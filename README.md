# 實景 AI 工作室

在筆電本機的 3D 房間裡，把一份文件交給企劃與審查。三份成果會依序出現在成果區，可以回查原文、對照和下載。

## 在 Windows 啟動

在 PowerShell 執行。已實測的 Node.js 版本為 22.16.0。

```powershell
Set-Location -LiteralPath 'C:\Users\lawki\Desktop\Taichung DevDays\06-spatial-ai-office'
npm.cmd ci
npm.cmd run build
npm.cmd start
```

在 Chrome 或 Edge 開啟 [本機工作室](http://127.0.0.1:4174)。預設場景是「開放式公寓」，按「試走」可看兩個角色沿客廳與廚房間的通道移動。用 Ctrl+C 停止伺服器。也可用 `npm.cmd start -- --kitchen` 開啟 Scaniverse 廚房，或用 `npm.cmd start -- --linford` 開啟林間長椅。 [公寓範例](https://superspl.at/scene/96ec171a)

執行 `npm.cmd start -- --ready` 可用 SuperSplat 的 `ready` 精簡範例啟動。一般啟動會讀取你的本機場景設定，或使用工作區的預設範例。

## 設定 OpenAI API

在準備啟動工作室的同一個 PowerShell 輸入金鑰。金鑰會以隱藏輸入讀入，存於該程序的環境變數。

```powershell
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API key' -AsSecureString)).Password
npm.cmd run smoke:ai
npm.cmd start
```

1. 先檢查測試請求有回覆，並記下模型與耗時。這次獨立測試也會用到一筆平台額度。
2. 在工作室按「填入範例」和「開始派工」。等初稿、審查、修訂都顯示已保存。也可以用 [展示用文件](demo-input.md) 測試檔案匯入。
3. 打開修訂成果，點「回查審查 R1」，再點審查內的原文引用。下載三份 Markdown，確認三階段的模型 ID 和耗時都已留在任務紀錄。
4. 再按「歷史回放」檢查標示和事件順序。回放使用本機存檔，API 請求數維持不變。

工作室直接使用 OpenAI 的 `gpt-5.4-mini`。API 依帳戶用量計費。工作室每個任務最多五次請求，每個台北日最多四十次。逾時或限流時可在條件恢復後接續。開啟新 PowerShell 後要重新設定金鑰。使用可送往雲端的文字做測試。 [API 金鑰](https://platform.openai.com/api-keys) · [模型與價格](https://developers.openai.com/api/docs/models/gpt-5.4-mini)

## 換成自己的房間

1. 在 iPhone 的 Scaniverse Classic 用 Splat 模式掃描，直接匯出 `.spz` 或 Gaussian Splat `.ply` 到本機。
2. 用 SuperSplat Editor 裁切、清理並對齊，保存 `.ssproj`，另匯出 `.sog`。
3. 在專案的 `.local\assets` 放入 `room.sog`。複製 `scene.example.json` 為 `.local\scene.json`，更新 `id`、`name`、`attribution` 和 `splat`（`/assets/room.sog`）。
4. 編輯場景的位置、旋轉、尺度與初始相機，手動調整 `anchors`、`routes` 和 `robotScale`。三座標依序為 X、Y 高度、Z。路線是世界座標的連續路標。重啟工作室，加上 `?calibrate=1` 可顯示站點方塊，方便檢查角色接地與轉角。

`.local` 保存場景設定、個人素材和 SQLite 任務紀錄，已由 Git 排除。部署資源只從本機載入。先關閉工作室，再備份整個 `.local` 目錄。

## 量測與排練

- 接電並讓瀏覽器使用硬體加速。在「效能量測」先按「純 Splat」，沿固定方向小幅轉動鏡頭 30 秒，再以相同方式測「雙角色」。記下畫布尺寸、GPU 和中位數 FPS。1080p 結果以實際量測尺寸為準。
- 若場景出現掉幀，先關閉不需要的高負載程式，再縮減場景的 splats。可試效能模式，也可加 `?renderer=webgl` 切到 WebGL 重新驗證。
- 本機已測得 `ready` 精簡版開啟效能模式時，1280×720 雙角色中位數為 33.7 FPS。展示時可保留視窗模式，將 3D 畫布維持在約 720p。
- 90 秒展示可分成 15 秒看房間、15 秒派工、20 秒看 NPC、20 秒開原文、20 秒看修訂。提前保存一筆成功任務，現場等待較長時切到標有「歷史回放」的紀錄。
- `npm.cmd test` 使用隔離的測試資料庫和模型回覆，涵蓋引用驗證、逾時、取消、重連、重啟與額度。測試需要存取本機 loopback。

素材來源見 [第三方來源與授權](THIRD_PARTY_NOTICES.md)，實測結果見 [驗收紀錄](VERIFICATION.md)。
