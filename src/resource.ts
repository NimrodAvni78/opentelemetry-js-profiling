import { ResourceAttributes } from './types';

export function resolveResource(config?: {
  serviceName?: string;
  attributes?: ResourceAttributes;
}): ResourceAttributes {
  const attrs: ResourceAttributes = {
    'service.name': 'unknown',
    'telemetry.sdk.language': 'javascript',
    'telemetry.sdk.name': '@opentelemetry/profiling-node',
    'runtime.name': 'nodejs',
    'runtime.version': process.version,
    'process.pid': process.pid,
  };

  // Parse OTEL_RESOURCE_ATTRIBUTES (comma-separated key=value, percent-encoded)
  const envAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (envAttrs) {
    for (const pair of envAttrs.split(',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const key = decodeURIComponent(pair.slice(0, eqIdx).trim());
      const value = decodeURIComponent(pair.slice(eqIdx + 1).trim());
      if (key) attrs[key] = value;
    }
  }

  // OTEL_SERVICE_NAME overrides resource attribute
  const envServiceName = process.env.OTEL_SERVICE_NAME;
  if (envServiceName) attrs['service.name'] = envServiceName;

  // Programmatic config overrides env
  if (config?.serviceName) attrs['service.name'] = config.serviceName;
  if (config?.attributes) Object.assign(attrs, config.attributes);

  return attrs;
}
