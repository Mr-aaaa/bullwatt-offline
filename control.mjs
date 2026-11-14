const resultMessages = {
  2: '骑行台不支持该指令', 3: '骑行台拒绝了参数',
  4: '骑行台执行失败', 5: '骑行台未授予控制权',
};
export const fallbackRange = { min: 0, max: 600, step: 1 };

export function normalizePower(value, { min, max, step } = fallbackRange) {
  const watts = Number(value);
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
      !Number.isFinite(watts) || watts < 0) throw new Error('请输入有效的非负瓦数');
  const increments = Math.min(Math.floor((max - min) / step), Math.round((Math.max(min, watts) - min) / step));
  return min + increments * step;
}

export class ControlPoint {
  constructor(write, timeout = 3000) {
    this.write = write;
    this.timeout = timeout;
  }

  async send(bytes) {
    if (this.closed) throw new Error('请重新连接骑行台');
    if (this.pending) throw new Error('上一条指令尚未完成');
    const data = Uint8Array.from(bytes);
    await new Promise((resolve, reject) => {
      const pending = {
        opcode: data[0], written: false, result: null, resolve, reject,
        timer: setTimeout(() => this.close(new Error('骑行台响应超时，请重新连接')), this.timeout),
      };
      this.pending = pending;
      Promise.resolve().then(() => this.write(data)).then(() => {
        if (this.pending !== pending) return;
        pending.written = true;
        this.settle();
      }).catch(error => {
        if (this.pending === pending) this.close(error);
      });
    });
  }

  receive(view) {
    if (!this.pending || view.byteLength < 3 || view.getUint8(0) !== 128 ||
        view.getUint8(1) !== this.pending.opcode) return;
    this.pending.result = view.getUint8(2);
    this.settle();
  }

  settle() {
    const pending = this.pending;
    if (!pending?.written || pending.result === null) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (pending.result === 1) pending.resolve();
    else pending.reject(new Error(resultMessages[pending.result] ?? '骑行台拒绝了指令'));
  }

  close(error = new Error('骑行台已断开')) {
    this.closed = true;
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

export class LatestPower {
  constructor(send) {
    this.send = send;
  }

  set(watts) {
    this.next = watts;
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  cancel() {
    this.next = null;
  }

  async drain() {
    try {
      while (this.next != null) {
        const watts = this.next;
        this.cancel();
        await this.send(watts);
      }
    } finally {
      this.cancel();
      this.running = null;
    }
  }
}
