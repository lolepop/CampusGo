import winston from 'winston';
import path from 'node:path';
import config from "./config.js";
import { traceLogFields } from "./telemetry/tracing.ts";

// Base format
const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format(info => Object.assign(info, traceLogFields()))(),
  winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'stack', 'trace_id', 'span_id'] })
);

// Console format (pretty + colour)
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, metadata, trace_id, span_id } = info;
    // build readable string
    const metaStr = metadata && Object.keys(metadata).length
      ? `\n${JSON.stringify(metadata, null, 2)}`
      : '';
    // show stack trace if it's an error
    const stackStr = stack ? `\n${stack}` : '';
    const traceStr = trace_id ? ` [trace=${trace_id} span=${span_id}]` : '';
    return `${timestamp} [${level}]${traceStr}: ${message}${metaStr}${stackStr}`;
  })
);

// File format (clean, no colour)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  // winston.format.json() // structured JSON for files
  // plain text:
  winston.format.printf(({ timestamp, level, message, stack, trace_id, span_id }) =>
    `${timestamp} [${level}]${trace_id ? ` [trace=${trace_id} span=${span_id}]` : ''}: ${message}${stack ? '\n' + stack : ''}`
  )
);

const generateFileLoggers = () => {
    if (!config.shouldGenerateLogfile)
        return [];
    return [
        new winston.transports.File({
          filename: path.join('logs', 'error.log'),
          level: 'error',
          format: fileFormat,
        }),
        new winston.transports.File({
          filename: path.join('logs', 'combined.log'),
          format: fileFormat,
        })
    ];
}

// Create the logger
export default winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: baseFormat,
  transports: [
    ...generateFileLoggers(),
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? winston.format.json() : consoleFormat,
    }),
  ],
  exitOnError: false,
});
