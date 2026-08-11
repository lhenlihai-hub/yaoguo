// @ts-check

class KeyedSerialExecutor {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.tails = new Map();
  }

  /**
   * Serialize work for one logical owner without coupling unrelated owners.
   * A rejected operation never poisons the queue behind it.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T> | T} operation
   * @returns {Promise<T>}
   */
  run(key, operation) {
    const normalized = `${key || "application"}`;
    const previous = this.tails.get(normalized) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation);
    // tail 只是内部排队哨兵，必须永远 resolve。若把 current.finally() 直接
    // 存进去，operation 的 rejection 会在派生 Promise 上变成未处理拒绝；
    // 即使调用者已经 catch(current)，Node 仍可能退出整个 Electron main。
    const tail = current.then(
      () => undefined,
      () => undefined
    ).then(() => {
      if (this.tails.get(normalized) === tail) this.tails.delete(normalized);
    });
    this.tails.set(normalized, tail);
    return current;
  }
}

module.exports = { KeyedSerialExecutor };
