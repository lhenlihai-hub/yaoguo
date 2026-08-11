// @ts-check

const path = require("node:path");
const picomatch = require("picomatch");
const { isPathInside } = require("../../shared/pathSafety");
const { toPosixPath } = require("./instructionPaths");

function candidateMatchesTargets(candidate = {}, targets = [], options = {}) {
  const patterns = Array.isArray(candidate.patterns) ? candidate.patterns : null;
  if (!patterns) return true;
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  if (!positive.length || patterns.some(hasParentSegment)) return false;
  const matchOptions = { dot: true, nocase: options.platform === "win32", strictBrackets: true };
  try {
    const include = positive.map((pattern) => picomatch(pattern, matchOptions));
    const exclude = negative.map((pattern) => picomatch(pattern, matchOptions));
    return targets.some((target) => {
      const base = path.resolve(candidate.patternBase || options.scopeRoot || ".");
      const absolute = path.resolve(target);
      if (!isPathInside(base, absolute)) return false;
      const relative = toPosixPath(path.relative(base, absolute) || ".");
      return include.some((matcher) => matcher(relative)) && !exclude.some((matcher) => matcher(relative));
    });
  } catch {
    return false;
  }
}

function validateInstructionPatterns(patterns = []) {
  if (!Array.isArray(patterns)) return "";
  if (!patterns.some((pattern) => !pattern.startsWith("!"))) {
    return "pat 至少需要一个正向 pattern";
  }
  if (patterns.some(hasParentSegment)) return "pat 不能包含 .. 路径段";
  try {
    for (const pattern of patterns) {
      picomatch(pattern.startsWith("!") ? pattern.slice(1) : pattern, {
        dot: true,
        strictBrackets: true
      });
    }
    return "";
  } catch (error) {
    return `${error?.message || "glob 语法无效"}`.slice(0, 240);
  }
}

function hasParentSegment(pattern = "") {
  return `${pattern || ""}`.split(/[\\/]+/).includes("..");
}

module.exports = {
  candidateMatchesTargets,
  hasParentSegment,
  validateInstructionPatterns
};
