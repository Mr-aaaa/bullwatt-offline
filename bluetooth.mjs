import { indoorBikeData } from './dependencies/auuki/src/ble/ftms/indoor-bike-data.js';
import { heartRateMeasurement } from './dependencies/auuki/src/ble/hrs/heart-rate-measurement.js';
import { control } from './dependencies/auuki/src/ble/ftms/control-point.js';
import { ControlPoint, fallbackRange } from './control.mjs';

export class Device {
  constructor(kind, onData, onDisconnect) {
    Object.assign(this, { kind, onData, onDisconnect, range: fallbackRange });
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('蓝牙需要支持 Web Bluetooth 的 Chrome 和 HTTPS 页面');
    const trainer = this.kind === 'trainer';
    const serviceId = trainer ? 0x1826 : 0x180d;
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [serviceId] }] });
    this.device = device;
    const listeners = new AbortController();
    this.listeners = listeners;
    const options = { signal: listeners.signal };
    device.addEventListener('gattserverdisconnected', () => this.cleanup(true), options);
    try {
      const gatt = await device.gatt.connect();
      const service = await gatt.getPrimaryService(serviceId);
      const data = await service.getCharacteristic(trainer ? 0x2ad2 : 0x2a37);
      data.addEventListener('characteristicvaluechanged', ({ target }) => {
        try {
          const values = trainer ? indoorBikeData.decode(target.value) : heartRateMeasurement.decode(target.value);
          if (trainer && values.power > 32767) values.power -= 65536;
          if (!trainer && values.sensorContactSupported && !values.sensorContactStatus) values.heartRate = null;
          this.onData(values);
        } catch (error) {
          console.warn('Invalid Bluetooth measurement', error);
        }
      }, options);
      await data.startNotifications();
      if (trainer) {
        const point = await service.getCharacteristic(0x2ad9);
        this.point = new ControlPoint(bytes => point.writeValueWithResponse(bytes));
        point.addEventListener('characteristicvaluechanged', ({ target }) => this.point?.receive(target.value), options);
        await point.startNotifications();
        this.range = fallbackRange;
        this.rangeVerified = false;
        try {
          const characteristic = await service.getCharacteristic(0x2ad8);
          const view = await characteristic.readValue();
          const deviceMin = view.getInt16(0, true);
          const max = view.getInt16(2, true);
          const step = view.getUint16(4, true);
          const min = deviceMin < 0 ? deviceMin + Math.ceil(-deviceMin / step) * step : deviceMin;
          if (Number.isFinite(min) && max >= min && step > 0) {
            this.range = { min, max, step };
            this.rangeVerified = true;
          }
        } catch (error) {
          console.info('Supported power range unavailable', error);
        }
      }
      if (listeners.signal.aborted || !device.gatt.connected) throw new Error('设备已断开');
      this.connected = true;
      return device.name || (trainer ? '骑行台' : '心率设备');
    } catch (error) {
      this.cleanup(false);
      throw error;
    }
  }

  requestControl() {
    return this.command(new Uint8Array(control.requestControl.encode()));
  }

  setPower(watts) {
    return this.command(new Uint8Array(control.powerTarget.encode({ power: watts })));
  }

  command(bytes) {
    if (!this.connected || !this.point) return Promise.reject(new Error('请连接骑行台'));
    return this.point.send(bytes);
  }

  cleanup(notify = true) {
    this.listeners?.abort();
    this.point?.close();
    this.point = null;
    this.connected = false;
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.device = null;
    if (notify) this.onDisconnect();
  }
}
