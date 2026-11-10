/** Only known transport failures can stay silent when a usable snapshot exists. */
export function transientRefreshError(error) {
  if (error?.name === 'RemoteStreamCarrierError') return true;
  if (error?.code === 'HTTP_ERROR') return [408, 425, 429, 502, 503, 504].includes(error.status);
  return error instanceof TypeError && /fetch|network|load failed|networkerror|网络/i.test(error.message);
}
