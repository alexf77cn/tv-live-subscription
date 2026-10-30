# 央视与卫视自动订阅

从三个公开 GitHub 源仓库提取指定央视、卫视频道，定时合并成 MYTV JSON。初始配置共 80 台：央视 17、卫视 26、香港 15、澳门 4、台湾 18。只有前两组线路自动更新，港澳台 37 项保持完整不变，频道顺序保持稳定。

正式订阅地址为仓库 GitHub Pages 下的 `channels.json`；`report.json` 可查看最近成功时间、各上游是否可访问、每条检测结果及采用线路。初始 `docs/channels.json` 是人工核验的配置，首次运行更新后才会有自动探测报告。

## 更新机制

- GitHub Actions 每天北京时间 06:23 运行，也可在 Actions 中手动触发。定时任务可能被 GitHub 排队延迟，并非上游提交后即时推送。
- 仅接受种子文件中预定的央视、卫视频道名称及严格别名；CCTV-5 和 CCTV-5+ 分开识别。不会把第三方表中的其他频道整体导入。
- 复测当前首选。它仍由上游收录，或属于人工验证的保底线路，且检测通过时保留首位；失效或被上游移除的普通候选可由新的通过者替代。每次同时刷新最多两条上游候选，保留所有人工保底，并在容量允许时保留之前已更新的备选，每台最多六条。
- 检查 HTTP、真实 HLS 结构及一个媒体分片的初始字节，拒绝 HTML、空清单、明确 VOD、已知错台/占位源及短期签名地址。请求有大小、超时、并发、跳转和协议限制；重定向得到的短期地址不写入频道表。
- 单个源失败时仍可使用其他源；某频道未取得通过者就保留旧线路。全部上游失败、输出空表、频道身份/顺序/数量改变、港澳台配置变化时，任务失败且不部署，线上保留上一次发布版本。

**轻量检测不等于完整播放验收**：不会自动识别台标、广告画面、节目身份，也不保证 HLS 媒体序列持续前进、声音正常或长时间稳定。GitHub 服务器与电视的网络路径不同，仍可能出现云端可访问而本地不可访问。人工保底不会因一次云端失败被删除；需要时应在电脑抽帧复核并调整种子或黑名单。

## 上游

- [vbskycn/iptv：IPv4](https://github.com/vbskycn/iptv/blob/master/tv/iptv4.m3u)
- [zilong7728/Collect-IPTV：优选列表](https://github.com/zilong7728/Collect-IPTV/blob/main/best_sorted.m3u)
- [alantang1977/iptv_api：IPv4 多线路](https://github.com/alantang1977/iptv_api/blob/main/output/live_ipv4.m3u)

来源和检测限制在 `config/sources.json`；人工保底与固定港澳台配置在 `config/seed-channels.json`。只包含公开直播地址及凤凰在播放器内的 `127.0.0.1` 动态入口，不需要账户凭证，也不需要电脑常开。

## 部署与电视设置

1. 将本项目放入专用 GitHub 仓库，默认分支为 `main`。在 Settings → Pages 中选择 **GitHub Actions** 作为来源；确认仓库允许 Actions 写入内容。
2. 运行 `Refresh live subscription`，等合并、提交和 Pages 部署全部成功，再验证 Pages 的 `channels.json` 为完整 80 项 JSON。
3. 在支持凤凰 `/fh/` 的 `my-newtv` 中导入这个完整 JSON 的订阅 URL，并开启 **“应用启动后更新视频源”**。
4. 播放器在重新启动应用时拉取最新订阅，连续观看或仅从后台回到前台并非定时刷新。GitHub 更新频率和电视拉取时机是两回事。

GitHub Actions 使用自己的令牌提交文件不会自动触发普通分支式 Pages 构建，所以工作流显式上传并部署 Pages。官方 Actions 已固定到审核时的提交 SHA。成功任务会提交带生成时间的报告，正常运行时保持仓库活动；若长期失败或停用，仍需检查 [GitHub 定时任务的 60 天无活动限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

恢复电视静态列表前先关闭“应用启动后更新视频源”；仅导入文本不会清除旧订阅地址，下一次重启可能再次加载订阅。

## 本地验证

需要 Node.js 22 或更新版本，不需要安装第三方包：

```sh
node --test
node src/update.mjs
```

Windows 可双击 `refresh-local.bat` 进行本地测试与生成；该脚本不会发布 GitHub，也不会操作电视。离线测试覆盖空表/HTML防护、单源和全部源失败、体育频道别名、首选健康与失效、港台保护、删台保护和危险跳转。
