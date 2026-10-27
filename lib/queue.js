'use strict';

class Queue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, concurrency | 0);
    this.running = 0;
    this.pending = [];
  }

  // Returns a promise that resolves with fn()'s result once a slot is
  // free. fn should itself return a promise.
  push(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.running++;
        Promise.resolve()
          .then(fn)
          .then(
            (val) => {
              this.running--;
              resolve(val);
              this._next();
            },
            (err) => {
              this.running--;
              reject(err);
              this._next();
            }
          );
      };
      this.pending.push(task);
      this._next();
    });
  }

  _next() {
    if (this.running >= this.concurrency) return;
    const task = this.pending.shift();
    if (task) task();
  }

  get size() {
    return this.pending.length + this.running;
  }
}

module.exports = { Queue };
