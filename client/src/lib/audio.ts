// Audio byte helpers shared by the client.

import { bytesToBase64 } from "@hatch/space-sdk/client";

/** Encode a Blob as base64 (safe for multi-MB recordings). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}
