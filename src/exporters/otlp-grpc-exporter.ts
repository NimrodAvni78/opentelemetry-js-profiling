import { connect, constants, ClientHttp2Session } from 'node:http2';
import { URL } from 'node:url';
import { ProfileData, ProfileExporter, ResourceAttributes } from '../types';
import { buildExportRequest } from '../convert/pprof-to-otlp';

function frameMessage(buffer: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + buffer.length);
  frame[0] = 0;
  frame.writeUInt32BE(buffer.length, 1);
  Buffer.from(buffer).copy(frame, 5);
  return frame;
}

export interface OtlpGrpcExporterConfig {
  endpoint?: string;
  headers?: Record<string, string>;
}

export class OtlpGrpcProfileExporter implements ProfileExporter {
  private readonly host: string;
  private readonly port: string;
  private readonly secure: boolean;
  private readonly headers: Record<string, string>;

  constructor(config: OtlpGrpcExporterConfig = {}) {
    const url =
      config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = parsed.port || '4317';
    this.secure = parsed.protocol === 'https:';
    this.headers = { ...(config.headers ?? {}) };

    const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
    if (headersEnv) {
      for (const pair of headersEnv.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) continue;
        const key = pair.slice(0, eqIdx).trim().toLowerCase();
        const value = pair.slice(eqIdx + 1).trim();
        if (key) this.headers[key] = value;
      }
    }
  }

  async export(data: ProfileData, resource: ResourceAttributes): Promise<void> {
    const { encoded } = buildExportRequest(
      [{ profile: data.profile, profileType: data.profileType }],
      resource,
    );
    const framed = frameMessage(encoded);
    await this.send(framed);
  }

  async shutdown(): Promise<void> {}

  private send(framedPayload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const authority = `${this.secure ? 'https' : 'http'}://${this.host}:${this.port}`;
      const client: ClientHttp2Session = connect(authority, { rejectUnauthorized: false });
      let settled = false;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        client.close();
        if (err) reject(err);
        else resolve();
      };

      client.on('error', (err: Error) => settle(err));

      const grpcPath =
        '/opentelemetry.proto.collector.profiles.v1development.ProfilesService/Export';
      const stream = client.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: grpcPath,
        'content-type': 'application/grpc',
        te: 'trailers',
        ...this.headers,
      });

      const handleGrpcStatus = (meta: Record<string, string>) => {
        const grpcStatus = meta['grpc-status'];
        if (grpcStatus === undefined) return;
        if (grpcStatus === '0') {
          settle();
        } else {
          settle(
            new Error(
              `OTLP gRPC export failed: status=${grpcStatus} message=${meta['grpc-message'] || 'Unknown'}`,
            ),
          );
        }
      };

      stream.on('response', handleGrpcStatus);
      stream.on('trailers', handleGrpcStatus);
      stream.on('end', () => settle());
      stream.on('error', (err: Error) => settle(err));
      stream.write(framedPayload);
      stream.end();
    });
  }
}
