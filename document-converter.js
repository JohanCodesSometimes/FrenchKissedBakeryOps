const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const textFirstExtensions = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".csv", ".html", ".htm",
  ".txt", ".md", ".json", ".xml", ".rtf", ".epub",
]);

async function convertToMarkdown(filePath, options = {}) {
  const logger = options.logger || console;
  const extension = path.extname(filePath).toLowerCase();
  const python = options.python || process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  const script = options.script || path.join(__dirname, "scripts", "convert_to_markdown.py");
  const runner = options.runner || execFileAsync;

  try {
    const { stdout } = await runner(python, [script, filePath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 90_000,
      windowsHide: true,
    });
    const markdown = String(stdout || "").trim();
    const quality = assessMarkdown(markdown);
    const textFirst = textFirstExtensions.has(extension);
    const usable = textFirst && quality.usable;
    return {
      ok: usable,
      markdown,
      method: "markitdown",
      textFirst,
      fallbackRequired: !usable,
      quality,
    };
  } catch (error) {
    logger.warn(`[documents] MarkItDown failed for ${path.basename(filePath)} (${safeErrorName(error)}). Falling back.`);
    return {
      ok: false,
      markdown: "",
      method: "fallback",
      textFirst: textFirstExtensions.has(extension),
      fallbackRequired: true,
      quality: assessMarkdown(""),
    };
  }
}

function assessMarkdown(markdown) {
  const text = String(markdown || "").replace(/\s+/g, " ").trim();
  const meaningfulCharacters = (text.match(/[\p{L}\p{N}$%]/gu) || []).length;
  const characterCount = text.length;
  const meaningfulRatio = characterCount ? meaningfulCharacters / characterCount : 0;
  return {
    usable: characterCount >= 40 && meaningfulCharacters >= 20 && meaningfulRatio >= 0.25,
    characterCount,
    meaningfulCharacters,
  };
}

function safeErrorName(error) {
  if (error?.killed) return "timeout";
  if (error?.code === "ENOENT") return "runtime unavailable";
  return error?.name || "conversion error";
}

module.exports = { convertToMarkdown, assessMarkdown, textFirstExtensions };
