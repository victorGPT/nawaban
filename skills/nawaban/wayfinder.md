# wayfinder 地图

地图是一张记了 `note "wayfinder: map"` 的父票，正文保持初稿，变化记在事件里。

- 加一张 → `nawaban create <票> --parent <地图>`，再记 `note "wayfinder: <类型>"`。可开工的看 `nawaban list --parent <地图> --frontier`。
- 定了一张 → 在它上面记结论 `decision`，在地图记 `decided: <票> <标题>: <一句结论>`，再 `close --done`。调研票先记 `link "commit:<调研分支上的 sha>"`。
- 超出范围 → `close --cancelled`，地图记 `out-of-scope: …`。
- 迷雾成了票 → 地图记 `graduated: <迷雾> → <票>`。
- 删一张 → 取消它，记一条写明理由的 note。
