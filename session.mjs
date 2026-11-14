const fields = ['power', 'requestedPower', 'acceptedPower', 'heartRate', 'cadence'];

export function sample(ride, now, duration, readings) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 5) return false;
  ride.activeSeconds += duration;
  const point = { timestamp: new Date(now).toISOString(), elapsedSeconds: ride.activeSeconds, durationSeconds: duration };
  for (const field of fields) point[field] = Number.isFinite(readings[field]) ? readings[field] : null;
  ride.samples.push(point);
  return true;
}

export function summary(ride) {
  return Object.fromEntries(['power', 'heartRate', 'cadence'].map(field => {
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
        !nonnegative(ride.activeSeconds) || !Array.isArray(ride.events) ||
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
