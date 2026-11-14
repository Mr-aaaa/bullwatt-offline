function plot(label, points, fields, start, end) {
  const figure = document.createElement('div');
  figure.className = 'chart';
  const legend = document.createElement('small');
  let max = -Infinity;
  let min = Infinity;
  for (const point of points) {
    for (const [key] of fields) {
      if (!Number.isFinite(point[key])) continue;
      min = Math.min(min, point[key]);
      max = Math.max(max, point[key]);
    }
  }
  const hasData = Number.isFinite(max);
  if (fields.length > 1) min = Math.min(0, min);
  max = Math.max(min + 1, max);
  legend.textContent = hasData ? label + ' · ' + Math.round(min) + '–' + Math.round(max) : label + ' · 暂无数据';
  figure.append(legend);
  if (!hasData) return figure;
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 128;
  canvas.setAttribute('aria-label', label);
  figure.append(canvas);
  const ctx = canvas.getContext('2d');
  for (const [key, color] of fields) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let previous = null;
    for (const point of points) {
      const time = Date.parse(point.timestamp);
      if (!Number.isFinite(point[key])) {
        previous = null;
        continue;
      }
      const x = 6 + 468 * (time - start) / Math.max(1000, end - start);
      const y = 122 - 116 * (point[key] - min) / (max - min);
      if (previous !== null && time - previous <= point.durationSeconds * 1000 + 100) ctx.lineTo(x, y);
      else {
        ctx.fillRect(x - 1, y - 1, 2, 2);
        ctx.moveTo(x, y);
      }
      previous = time;
    }
    ctx.stroke();
  }
  return figure;
}

export function drawCharts(container, points) {
  const start = Date.parse(points[0]?.timestamp);
  const end = Date.parse(points.at(-1)?.timestamp);
  container.replaceChildren(
    plot('功率 W · 蓝色实际 / 灰色已接受目标', points, [['power', '#0756e4'], ['acceptedPower', '#697b91']], start, end),
    plot('心率 bpm', points, [['heartRate', '#a43151']], start, end),
  );
}
