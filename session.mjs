const fields = ['power', 'requestedPower', 'acceptedPower', 'heartRate', 'cadence'];
const metrics = { power: 'power_w', heartRate: 'heart_rate_bpm', cadence: 'cadence_rpm' };

export function heartZone(bpm, maxBpm) {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(maxBpm) || maxBpm <= 0) return null;
  const percent = 100 * bpm / maxBpm;
  if (percent < 50) return 'easy';
  if (percent < 70) return 'moderate';
  if (percent < 85) return 'aerobic';
  return 'high';
}

export function sample(ride, now, duration, readings) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 5) return false;
  let elapsed;
  if (ride.durationMode === 'positive-power') {
    ride.recordedSeconds = (ride.recordedSeconds ?? 0) + duration;
    if (Number.isFinite(readings.power) && readings.power > 0) ride.activeSeconds += duration;
    elapsed = ride.recordedSeconds;
  } else {
    // Existing sessions retain their original recording-time duration.
    ride.activeSeconds += duration;
    elapsed = ride.activeSeconds;
  }
  const point = { timestamp: new Date(now).toISOString(), elapsedSeconds: elapsed, durationSeconds: duration };
  for (const field of fields) point[field] = Number.isFinite(readings[field]) ? readings[field] : null;
  ride.samples.push(point);
  return true;
}

export function summary(ride) {
  return Object.fromEntries(Object.keys(metrics).map(field => {
    let seconds = 0;
    let total = 0;
    let max = null;
    for (const point of ride.samples) {
      if (point[field] == null) continue;
      seconds += point.durationSeconds;
      total += point[field] * point.durationSeconds;
      max = max === null ? point[field] : Math.max(max, point[field]);
    }
    return [field, { seconds, mean: seconds ? total / seconds : null, max }];
  }));
}

export function compactReport(ride) {
  const interval = 30;
  const keys = Object.keys(metrics);
  const stats = summary(ride);
  const buckets = new Map();
  const round = value => value == null ? null : Math.round(value * 10) / 10;
  for (const point of ride.samples) {
    const end = point.elapsedSeconds;
    let from = Math.max(0, end - point.durationSeconds);
    while (from < end) {
      const start = Math.floor(from / interval) * interval;
      const edge = Math.min(end, start + interval);
      const length = edge - from;
      if (!buckets.has(start)) buckets.set(start, {
        seconds: 0, values: keys.map(() => ({ sum: 0, seconds: 0 })),
      });
      const bucket = buckets.get(start);
      bucket.seconds += length;
      for (const [index, field] of keys.entries()) {
        if (!Number.isFinite(point[field])) continue;
        bucket.values[index].sum += point[field] * length;
        bucket.values[index].seconds += length;
      }
      from = edge;
    }
  }
  return {
    format: 'bullwatt-summary-v1',
    started_at: ride.startedAt,
    active_s: round(ride.activeSeconds),
    ...(ride.durationMode === 'positive-power' ? {
      duration_basis: 'power_above_zero', recorded_s: round(ride.recordedSeconds),
    } : {}),
    metrics: Object.fromEntries(keys.map(field => [metrics[field], {
      mean: round(stats[field].mean), max: round(stats[field].max), recorded_s: round(stats[field].seconds),
    }])),
    interval_s: interval,
    columns: [ride.durationMode === 'positive-power' ? 'recorded_start_s' : 'active_start_s', 'sampled_s', ...Object.values(metrics)],
    trend: [...buckets].sort(([a], [b]) => a - b).map(([start, bucket]) => [
      start, round(bucket.seconds),
      ...bucket.values.map(value => value.seconds ? round(value.sum / value.seconds) : null),
    ]),
  };
}

export function csv(ride) {
  const columns = ['timestamp', 'elapsedSeconds', 'durationSeconds', ...fields];
  return [columns.join(','), ...ride.samples.map(point => columns.map(field => point[field] ?? '').join(','))].join('\r\n');
}

export function tcx(ride) {
  const points = ride.samples.map(point => {
    const heartRate = point.heartRate == null ? '' : '<HeartRateBpm><Value>' + Math.round(point.heartRate) + '</Value></HeartRateBpm>';
    const cadence = point.cadence == null ? '' : '<Cadence>' + Math.min(254, Math.round(point.cadence)) + '</Cadence>';
    const power = point.power == null ? '' : '<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Watts>' + Math.max(0, Math.round(point.power)) + '</Watts></TPX></Extensions>';
    return '<Trackpoint><Time>' + point.timestamp + '</Time>' + heartRate + cadence + power + '</Trackpoint>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking">' +
    '<Id>' + ride.startedAt + '</Id><Lap StartTime="' + ride.startedAt + '"><TotalTimeSeconds>' + ride.activeSeconds.toFixed(3) +
    '</TotalTimeSeconds><DistanceMeters>0</DistanceMeters><Calories>0</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>' +
    points + '</Track></Lap></Activity></Activities></TrainingCenterDatabase>';
}

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const nonnegative = value => Number.isFinite(value) && value >= 0;
export function validateBackup(data) {
  if (data?.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > 10000) throw new Error('无法识别备份格式');
  for (const ride of data.sessions) {
    if (ride?.schemaVersion !== 1 || typeof ride.id !== 'string' || !ride.id || ride.id.length > 128 ||
        typeof ride.name !== 'string' || !validDate(ride.startedAt) ||
        (ride.endedAt !== null && !validDate(ride.endedAt)) ||
        !['running', 'paused', 'completed', 'interrupted'].includes(ride.status) ||
        !nonnegative(ride.activeSeconds) ||
        (ride.durationMode !== undefined && (ride.durationMode !== 'positive-power' || !nonnegative(ride.recordedSeconds) ||
          ride.activeSeconds > ride.recordedSeconds)) ||
        !Array.isArray(ride.events) ||
        !ride.events.every(event => typeof event?.reason === 'string' && validDate(event.timestamp)) ||
        !Array.isArray(ride.samples) || !ride.samples.every(point =>
          validDate(point?.timestamp) && nonnegative(point.elapsedSeconds) &&
          Number.isFinite(point.durationSeconds) && point.durationSeconds > 0 && point.durationSeconds <= 5 &&
          fields.every(field => point[field] === null || (field === 'power' ?
            Number.isFinite(point[field]) && Math.abs(point[field]) <= 32768 : nonnegative(point[field]))))) {
      throw new Error('备份包含无效训练记录');
    }
  }
  return data.sessions;
}
