export const stable = (text: string, ...paths: string[]) =>
  paths
    .reduce((t, path) => t.replaceAll(path, '<tmp>'), text)
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<时刻>')
    .replace(/\b\d{4}-\d\d-\d\d\b/g, '<日期>')
    .replace(/@ [0-9a-f]{7,40}\b/g, '@ <提交>')
    .replace(/\b\d\d-\d\d \d\d:\d\d\b/g, '<月-日 时:分>')
    .replace(/\b\d\d:\d\d\b/g, '<时:分>')
