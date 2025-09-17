export const environment = {
  production: false,
  devAutoLogin: false,
  // Realtime hub URL (SignalR); align with swagger server
  lawnmowerHubUrl: 'http://localhost:3000/hub/lawnmower',
  // Enable/disable realtime hub usage; if disabled, polling fallback is used
  realtimeEnabled: true,
  // Polling fallback interval (ms), used when hub is disabled or unavailable
  refreshIntervalMs: 1000,
};
