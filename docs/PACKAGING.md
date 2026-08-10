# 打包发布说明

## 常用命令

- `npm run release:win`: 启动本地发布控制台，在浏览器中完成版本更新、Windows 打包、版本提交、tag 和 GitHub/Gitee 双远端推送。
- `npm run icons`: 生成 `build/icon.ico`、`build/icon.png` 和 Linux PNG 图标集。
- `npm run dist:dir`: 生成未安装目录包到 `release/win-unpacked`，用于快速验证打包内容。
- `npm run dist:win`: 生成未签名 Windows NSIS 安装包到 `release/`。
- `npm run dist:linux`: 生成 Linux AppImage 和 deb 包到 `release/`。
- `npm run dist:mac`: 生成 macOS dmg 和 zip 包到 `release/`，建议在 macOS 环境执行。
- `npm run dist:win:signed`: 生成签名 Windows 包，需先配置代码签名证书环境变量。

所有正式和验证打包产物统一输出到 `release/`，不要使用 `release-*` 临时输出目录。

## 本地发布控制台

执行以下命令后，脚本会监听随机的本机回环端口并自动打开浏览器：

```bash
npm run release:win
```

控制台会读取 `package.json` 当前版本和本地 `v*` tag 历史，并根据两者中的最高稳定版本推荐补丁、次版本和主版本号。确认发布后依次执行：

1. 检查当前分支、Git 身份、进行中的 Git 操作、目标 tag 和双远端分支状态。
2. 使用 `npm version --no-git-tag-version` 同步更新 `package.json` 与 `package-lock.json`。
3. 执行 `npm run dist:win -- --publish never`，确认 `release/` 中已生成对应版本的 NSIS 安装包、blockmap 和 `latest.yml`。
4. 按项目提交规范提交当前全部改动，创建带说明的 `v*` tag。
5. 分别向 Gitee 和 GitHub 原子推送当前分支与 tag。GitHub 收到 tag 后会触发 Actions，创建 GitHub Release，并将 Windows 更新资产镜像到 Gitee Release。

发布控制台默认识别指向 `gitee.com` 的现有远端。若尚未配置 GitHub 远端，会使用 `package.json` 的 `repository.url` 添加名为 `github` 的远端。HTTPS 远端需要提前通过 Git Credential Manager 配置凭据；脚本不会读取或保存访问令牌。

发布前必须显式勾选确认项。构建失败且尚未暂存时，脚本会恢复两个版本文件；本地提交或 tag 已生成后不会自动回滚，远端推送失败时可在当前页面重试。

Windows 安装包使用辅助安装向导，默认按当前用户安装，并允许用户选择安装目录。

Windows 正式版只发布 NSIS x64 安装包，不再生成 Portable 版本。发布控制台会校验下面三项产物全部存在，任一缺失都会停止提交和推送：

- `Git-UI-Pro-Setup-<version>-x64.exe`: NSIS 正式版安装包。
- `Git-UI-Pro-Setup-<version>-x64.exe.blockmap`: 增量下载索引。
- `latest.yml`: electron-updater 更新元数据；文件名固定，不包含版本号。

## Windows 应用内更新

应用内更新仅在通过 NSIS 安装的 Windows x64 正式版中启用。Portable、开发环境、网页预览和其他操作系统不检查在线更新源。

已安装应用启动后会静默检查 Gitee 国内更新源，Gitee 不可用或镜像尚未同步完整时自动回退到 GitHub。发现比当前版本更高的稳定版时，左上角显示更新入口。用户打开更新面板后手动开始下载，下载完成后再确认安装；应用不会在后台自动下载，也不会未经确认退出并安装。

首次启用时需要先发布并手动安装一个包含双更新源逻辑的基线版本。更早、尚未集成该更新器的旧版本不会自动切换到国内源；从基线版本开始，后续 Gitee 或 GitHub Release 均可完成应用内升级。

GitHub Release 必须同时上传同一版本的 NSIS `.exe`、对应 `.exe.blockmap` 和 `latest.yml`。Gitee Release 除这三项外还会上传 `update-manifest.json`，客户端会严格核对版本、文件名、下载域名和 SHA-256，并优先使用 blockmap 做差分下载；差分条件不满足时 electron-updater 会自动回退到完整安装包。镜像缺项或摘要不匹配时不会下载该安装包，而会尝试 GitHub 备用源。发布后应至少在一台未开启代理、已安装旧正式版的 Windows x64 设备上验证检查、下载、退出安装和重启后的版本号。

安装向导会在开始安装前显示桌面快捷方式选项，默认勾选“创建桌面快捷方式”，用户可以取消。

打包后的 Windows 应用会保留 `contextIsolation` 并关闭 renderer sandbox，以规避部分自定义安装目录下 Electron renderer 子进程启动失败导致的黑屏问题。

## Windows 签名

默认配置保留图标和版本资源编辑，但将 `win.signExecutable` 设为 `false`，方便本地生成未签名包。

正式发布前使用 `npm run dist:win:signed`，并按 electron-builder 约定提供证书：

- `CSC_LINK` 或 `WIN_CSC_LINK`: `.pfx` 文件路径、base64 内容或证书链接。
- `CSC_KEY_PASSWORD` 或 `WIN_CSC_KEY_PASSWORD`: 证书密码。

签名配置位于 `package.json` 的 `build.win.signtoolOptions`，当前使用 SHA-256 和 DigiCert RFC 3161 时间戳服务器。

未签名构建不会写入伪造的 `publisherName`，避免应用内更新把未签名安装包误判为发行商不匹配；使用真实证书执行签名构建时，electron-builder 会从证书自动生成发行商信息并启用签名校验。

## 原生模块

项目依赖 `@homebridge/node-pty-prebuilt-multiarch`。打包配置关闭 `npmRebuild`，使用 postinstall 已安装的 Electron ABI 预编译产物，并通过 `asarUnpack` 解包：

- `build/Release/**/*.node`
- `build/Release/*.dll`
- `build/Release/*.exe`
- `prebuilds/**/*`
- `third_party/**/*`

这样 packaged app 的终端功能可以从 `app.asar.unpacked` 读取 node-pty 原生文件。

## Electron runtime

`build.electronDist` 指向 `node_modules/electron/dist`，打包时复用本地已安装的 Electron runtime，避免发布验证阶段重复从 GitHub 下载 Electron。

首次生成 NSIS 安装包时，electron-builder 仍可能需要下载 NSIS 工具链并缓存到本机；缓存完成后后续构建会复用。

## GitHub Actions 多平台构建

项目已提供 `.github/workflows/build-installers.yml`，支持手动构建和 tag 构建：

- 手动构建：GitHub 仓库页面进入 `Actions` -> `Build Installers` -> `Run workflow`。
- tag 构建：推送 `v*` 格式 tag，例如 `v0.1.0`。

主发布工作流会分别在以下环境执行：

- `windows-latest`: `npm run dist:win`
- `ubuntu-latest`: `npm run dist:linux`

每个系统都会独立执行 `npm ci`，避免复用其它系统的 `node_modules`，这对 `node-pty` 这类原生依赖很重要。

构建产物会作为 GitHub Actions artifacts 上传，名称分别是：

- `git-ui-pro-windows-x64`
- `git-ui-pro-linux-x64`

Actions 只上传安装包、必要的 blockmap 和 Windows `latest.yml`，不上传 `win-unpacked`、`linux-unpacked` 等解包目录，避免 Release 阶段上传过多文件触发 GitHub secondary rate limit。

当工作流由 `v*` 格式 tag 触发时，会在 Windows 和 Linux 构建完成后自动创建 GitHub Release，并把安装包上传到该 Release。随后工作流使用 `scripts/sync-gitee-release.mjs` 创建或更新同标签的 Gitee Release，上传 Windows 安装包、blockmap、`latest.yml` 和最后生成的 SHA-256 更新清单。

首次启用国内镜像前，需要在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 中新增仓库密钥 `GITEE_TOKEN`。令牌由 Gitee 个人访问令牌页面创建，并需具备当前公开仓库的发行版创建、修改与附件上传权限。令牌只提供给 Actions，不写入代码、安装包或客户端。未配置该密钥时 GitHub Release 仍会正常发布，但工作流会给出警告，Gitee 国内更新源不会推进到新版本。

macOS runner 在免费 GitHub Actions 中经常长时间排队，因此 macOS 构建拆分到 `.github/workflows/build-macos-installer.yml`，需要时进入 `Actions` -> `Build macOS Installer` -> `Run workflow` 手动触发。macOS artifacts 生成后，可手动上传到对应 GitHub Release。

首次运行时，electron-builder 可能会下载对应系统的打包工具链，耗时会比本地构建更长。

## 远程仓库

Gitee 和 GitHub 远程仓库可以同时存在，不冲突。推荐保留 Gitee 为 `origin`，新增 GitHub 为 `github`：

```bash
git remote add github https://github.com/zjx150504-lgtm/Git_UI_Pro.git
git push github master
```

以后可以按需分别推送：

```bash
git push origin master
git push github master
```

正式发布版本时，同时推送 tag 到两个远程：

```bash
git push github v0.1.0
git push origin v0.1.0
```

GitHub 会通过 Actions 自动生成 Release；配置 `GITEE_TOKEN` 后，同一工作流会自动维护 Gitee 发行版，无需再手动上传更新安装包。
