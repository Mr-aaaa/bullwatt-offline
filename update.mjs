function waitForWorker(worker, finishedStates) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (worker.state === 'redundant') finish(new Error('新版缓存失败，请联网后重试'));
      else if (finishedStates.includes(worker.state)) finish();
    };
    const timer = setTimeout(() => finish(new Error('更新超时，请联网后重试')), 30000);
    worker.addEventListener('statechange', check);
    check();
  });
}

export async function activateUpdate(registration) {
  await registration.update();
  if (registration.installing) {
    await waitForWorker(registration.installing, ['installed', 'activating', 'activated']);
  }
  const worker = registration.waiting;
  if (worker) {
    const activated = waitForWorker(worker, ['activated']);
    worker.postMessage({ type: 'ACTIVATE_UPDATE' });
    await activated;
    return;
  }
  if (!registration.active) throw new Error('新版尚未就绪，请稍后重试');
  await waitForWorker(registration.active, ['activated']);
}

export async function updateApplication() {
  const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  await activateUpdate(registration);
}
