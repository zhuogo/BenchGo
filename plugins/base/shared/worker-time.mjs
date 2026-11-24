import { canonicalClientTimeZone, parseOffsetInstant } from '@deepseek-ai/dsh-util-time';

export function workerTimeContext(requestTime, fallbackRequestTime) {
  const clientZone = requestTime?.timeZone;
  const requestedZone = typeof clientZone === 'string' ? canonicalClientTimeZone(clientZone) : undefined;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: requestedZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const format = instant => {
    const { year, month, day, hour, minute, second, timeZoneName } = Object.fromEntries(
      formatter.formatToParts(instant).map(({ type, value }) => [type, value]),
    );
    return `${year.padStart(4, '0')}-${month}-${day}T${hour}:${minute}:${second}${timeZoneName.slice(3) || '+00:00'}`;
  };
  const requestInstant = requestTime?.at ?? fallbackRequestTime;
  const original = typeof requestInstant === 'string' ? parseOffsetInstant(requestInstant) : null;
  const context = {
    currentTime: format(Date.now()),
    timeZone: formatter.resolvedOptions().timeZone,
    timeZoneSource: requestedZone ? 'request-client' : 'execution-host',
    originalRequestTime: original?.kind === 'accepted' ? format(original.epoch) : null,
  };
  return 'Task time context: ' + JSON.stringify(context)
    + '\nUse this time zone for unqualified times in the original task. Interpret relative dates such as today against originalRequestTime when available. Respect explicit dates and time zones in user instructions.';
}
