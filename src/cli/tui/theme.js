"use strict";

const ESC = "\u001b[";

function style(open, close) {
  return (value) => `${open}${value || ""}${close}`;
}

const ansi = Object.freeze({
  reset: `${ESC}0m`,
  bold: style(`${ESC}1m`, `${ESC}22m`),
  dim: style(`${ESC}2m`, `${ESC}22m`),
  blue: style(`${ESC}38;2;75;156;255m`, `${ESC}39m`),
  blueBright: style(`${ESC}38;2;121;187;255m`, `${ESC}39m`),
  cyan: style(`${ESC}38;2;92;215;255m`, `${ESC}39m`),
  green: style(`${ESC}38;2;91;205;143m`, `${ESC}39m`),
  yellow: style(`${ESC}38;2;244;193;85m`, `${ESC}39m`),
  red: style(`${ESC}38;2;255;107;107m`, `${ESC}39m`),
  white: style(`${ESC}38;2;244;248;255m`, `${ESC}39m`),
  muted: style(`${ESC}38;2;139;153;173m`, `${ESC}39m`),
  code: style(`${ESC}38;2;174;214;255m`, `${ESC}39m`),
  userBackground: style(`${ESC}48;2;20;82;138m`, `${ESC}49m`),
  panelBackground: style(`${ESC}48;2;24;33;48m`, `${ESC}49m`),
  selectionBackground: style(`${ESC}48;2;35;91;145m`, `${ESC}49m`),
  underline: style(`${ESC}4m`, `${ESC}24m`),
  italic: style(`${ESC}3m`, `${ESC}23m`),
  strike: style(`${ESC}9m`, `${ESC}29m`)
});

function createTuiTheme() {
  const selectList = {
    selectedPrefix: (text) => ansi.blueBright(text),
    selectedText: (text) => ansi.selectionBackground(ansi.white(text)),
    description: (text) => ansi.muted(text),
    scrollInfo: (text) => ansi.muted(text),
    noMatch: (text) => ansi.yellow(text)
  };
  return {
    editor: {
      borderColor: (text) => ansi.blue(text),
      selectList
    },
    selectList,
    markdown: {
      heading: (text) => ansi.blueBright(ansi.bold(text)),
      link: (text) => ansi.cyan(ansi.underline(text)),
      linkUrl: (text) => ansi.muted(text),
      code: (text) => ansi.code(text),
      codeBlock: (text) => ansi.code(text),
      codeBlockBorder: (text) => ansi.blue(text),
      quote: (text) => ansi.muted(text),
      quoteBorder: (text) => ansi.blue(text),
      hr: (text) => ansi.blue(text),
      listBullet: (text) => ansi.blueBright(text),
      bold: (text) => ansi.bold(text),
      italic: (text) => ansi.italic(text),
      strikethrough: (text) => ansi.strike(text),
      underline: (text) => ansi.underline(text),
      codeBlockIndent: "  "
    },
    userText: {
      color: (text) => ansi.white(text),
      bgColor: (text) => ansi.userBackground(text)
    }
  };
}

function formatHeader(version) {
  return [
    `${ansi.blueBright(ansi.bold("腰果"))} ${ansi.muted(`v${version}`)}`,
    ansi.muted("基于 Pi · DeepSeek only · / 打开命令菜单")
  ].join("\n");
}

module.exports = { ansi, createTuiTheme, formatHeader };
