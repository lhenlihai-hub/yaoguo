// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");

const INVALID_LOCAL_ITEM_GRANT_MESSAGE = "本地文件授权已失效或路径已发生变化，请重新拖入。";

// 授权时保存的是 realpath。使用前再确认该绝对路径本身仍是
// 普通文件/目录，且 realpath 没有改变，防止授权后把它或父目录
// 换成指向其他位置的符号链接。
async function validateGrantedLocalItem(targetPath = "") {
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error(INVALID_LOCAL_ITEM_GRANT_MESSAGE);
  }
  const absolute = path.resolve(targetPath);
  try {
    const directStat = await fsp.lstat(absolute);
    if (directStat.isSymbolicLink()) throw new Error("symbolic-link");
    if (!directStat.isFile() && !directStat.isDirectory()) throw new Error("unsupported-type");
    const canonical = await fsp.realpath(absolute);
    if (canonical !== absolute) throw new Error("rebound-path");
    return {
      path: canonical,
      kind: directStat.isDirectory() ? "directory" : "file"
    };
  } catch {
    throw new Error(INVALID_LOCAL_ITEM_GRANT_MESSAGE);
  }
}

module.exports = {
  INVALID_LOCAL_ITEM_GRANT_MESSAGE,
  validateGrantedLocalItem
};
