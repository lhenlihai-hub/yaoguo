const { appendText } = require("../../runtime");

module.exports = {
async logCall(entry) {
    if (this.tokenLedger) {
      await this.tokenLedger.recordCall(entry).catch(async () => {
        if (this.paths?.aiCallsFile) await appendText(this.paths.aiCallsFile, `${JSON.stringify(entry)}\n`).catch(() => {});
      });
      return;
    }
    if (this.paths?.aiCallsFile) await appendText(this.paths.aiCallsFile, `${JSON.stringify(entry)}\n`).catch(() => {});
  }
};
