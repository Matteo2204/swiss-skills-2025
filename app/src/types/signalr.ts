// Minimal ambient declaration to satisfy TS when @microsoft/signalr is not installed.
// Runtime import is guarded and errors are caught with a fallback to polling.
declare module '@microsoft/signalr';

