/**
 * The AWS half of Project S3 sources, loaded on a source's first object
 * request so that a Station with the experimental feature off never loads the
 * S3 client.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export { GetObjectCommand, ListObjectsV2Command };

/** `assertCurrent` runs before every HTTP request the client sends. */
export function createProjectS3Client(
  entry: { region: string; profile: string },
  assertCurrent: () => void,
): S3Client {
  class SourceHttpHandler extends NodeHttpHandler {
    override handle(...args: Parameters<NodeHttpHandler['handle']>) {
      assertCurrent();
      return super.handle(...args);
    }
  }
  return new S3Client({
    region: entry.region,
    credentials: fromIni({ profile: entry.profile }),
    maxAttempts: 1,
    followRegionRedirects: false,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: new SourceHttpHandler({
      connectionTimeout: 20000,
      requestTimeout: 20000,
    }),
  });
}
