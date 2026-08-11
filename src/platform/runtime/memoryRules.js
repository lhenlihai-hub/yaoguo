function normalizeMemoryRule(value = "") {
  return String(value || "")
    .replace(/^[-*#>\d.、\s]+/, "")
    .replace(/^【[^】]+】/, "")
    .replace(/[“”"']/g, "")
    .replace(/[，。！？、；：,.!?;:\s]+/g, "")
    .toLowerCase()
    .trim();
}

function memoryRuleCore(value = "") {
  return normalizeMemoryRule(value)
    .replace(/(不要|不能|禁止|禁用|避免|不得|不需要|必须|需要|应该|优先|默认|每次|以后|下次|保持|使用|采用|加入|添加|创建|更新|支持|只|都|要)/g, "")
    .replace(/(用户|要求|内容|执行|工作流|流程|项目|全局|记忆|软件|系统|本次|当前|这个|该)/g, "")
    .trim();
}

function memoryPolarity(value = "") {
  const text = String(value || "");
  if (/(不要|不能|禁止|禁用|避免|不得|不需要|不可)/.test(text)) return "negative";
  if (/(必须|需要|应该|优先|默认|每次|以后|下次|保持|使用|采用|加入|添加|创建|更新|支持)/.test(text)) return "positive";
  return "neutral";
}

function hasPotentialMemoryConflict(existingRule = "", nextRule = "") {
  const existingCore = memoryRuleCore(existingRule);
  const nextCore = memoryRuleCore(nextRule);
  if (!existingCore || !nextCore) return false;
  const sameCore = existingCore.includes(nextCore) || nextCore.includes(existingCore);
  if (!sameCore) return false;
  const existingPolarity = memoryPolarity(existingRule);
  const nextPolarity = memoryPolarity(nextRule);
  return existingPolarity !== "neutral" && nextPolarity !== "neutral" && existingPolarity !== nextPolarity;
}

function extractStoredMemoryRules(content = "") {
  return String(content || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^（[^）]+）\s*/, "").trim())
    .filter(Boolean);
}

function cleanRequirementCandidate(value = "", maxLength = 420) {
  return String(value || "")
    .replace(/^[-*#>\d.、\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/^(我认为|我觉得|这里|现在|另外|还有|以及|并且|所以|因此)[，,:：\s]*/, "")
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  normalizeMemoryRule,
  memoryRuleCore,
  memoryPolarity,
  hasPotentialMemoryConflict,
  extractStoredMemoryRules,
  cleanRequirementCandidate
};
