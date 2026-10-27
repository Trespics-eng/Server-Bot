import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level: logLevel,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'creds',
      'keys',
      'password',
      'secret',
      'token',
      'qr',
      'authorization',
      'service_role_key',
      'sessionData',
    ],
    censor: '[REDACTED]',
  },
});

export default logger;
