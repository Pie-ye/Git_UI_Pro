# Changelog

本项目遵循语义化版本思路记录重要变更。

## v0.1.34 - 2026-08-12

### Added

- 加入繁體中文（台灣）介面支援，將 renderer 內建的簡體中文介面字串轉為繁體中文與台灣慣用術語。
- 補充台灣常用 Git/UI 用語，例如「專案」、「儲存庫」、「檔案」、「設定」、「預設」、「重新整理」、「原始碼」與「遠端」。

### Changed

- 將 HTML 文件語系標記由 `zh-CN` 調整為 `zh-TW`。
- 調整安裝包發行 workflow，支援透過 `release/*` PR、`v*` tag 或手動 workflow dispatch 建置並發行 GitHub Release。

## v0.1.5 - 2026-07-07

### Fixed

- 收窄 GitHub Actions artifacts 上传范围，仅发布安装包文件，避免上传解包目录触发 GitHub secondary rate limit。

## v0.1.4 - 2026-07-07

### Changed

- 将主发布 workflow 调整为 Windows/Linux 构建完成后即可发布，避免 macOS runner 长时间排队阻塞 Release。
- 将 macOS 安装包拆分为单独手动 workflow，便于后续按需补充 macOS artifacts。

## v0.1.3 - 2026-07-07

### Fixed

- 修复首次安装后真实桌面环境错误显示开发用 mock 项目 `Git-UI-Pro` 的问题。
- 修复 Windows 中文仓库路径、中文文件名或中文 Git 输出在部分环境下解码错乱的问题。

## v0.1.2 - 2026-07-07

### Added

- 建立 Electron、React、TypeScript 桌面应用工程。
- 支持添加、扫描、搜索、收藏和切换多个本地 Git 项目。
- 支持源代码管理视图，包含暂存、取消暂存、丢弃改动、提交和 amend。
- 支持 Git 提交图、分支引用筛选、提交展开、提交详情和文件 diff。
- 支持 fetch、pull、push、新建分支、切换分支、删除分支和从提交创建分支。
- 增加中文 Git 操作提示、危险操作确认和反馈弹窗。
- 增加底部控制台和项目级终端能力。
- 增加 Windows、Linux、macOS 打包脚本和 GitHub Actions 多平台构建。

### Changed

- 优化源代码管理区域、提交图区域、分割条、文件标签、分支标签和项目栏的交互细节。
- 优化项目切换、历史图加载、状态刷新和提交图渲染性能。

### Known Issues

- Windows 安装包暂未做代码签名，安装时可能出现系统安全提示。
- macOS 安装包暂未做签名和 notarization，首次打开可能需要用户手动授权。
- 当前版本仍以中文界面和常见 Git 操作为主，复杂 Git 操作会继续补齐。
