import { randomUUID } from "node:crypto";
import { Storage, type File } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type ClientLogoContentType = keyof typeof extensions;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function privateObjectDir() {
  const dir = process.env.PRIVATE_OBJECT_DIR?.replace(/\/+$/, "");
  if (!dir) throw new Error("Private object storage is not configured.");
  return dir;
}

function splitBucketPath(path: string) {
  const [bucketName, ...parts] = path.split("/").filter(Boolean);
  const objectName = parts.join("/");
  if (!bucketName || !objectName) throw new Error("Invalid private object path.");
  return { bucketName, objectName };
}

async function signPut(bucketName: string, objectName: string) {
  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "PUT",
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Could not create a private logo upload URL.");
  const result = await response.json() as { signed_url?: string };
  if (!result.signed_url) throw new Error("Could not create a private logo upload URL.");
  return result.signed_url;
}

export async function requestClientLogoUpload(clientId: string, contentType: ClientLogoContentType) {
  const extension = extensions[contentType];
  const objectName = `client-logos/${clientId}/${randomUUID()}.${extension}`;
  const { bucketName, objectName: storageName } = splitBucketPath(`${privateObjectDir()}/${objectName}`);
  const uploadURL = await signPut(bucketName, storageName);
  return { uploadURL, objectPath: `/objects/${objectName}` };
}

export function isClientLogoPath(clientId: string, objectPath: string) {
  if (!new RegExp(`^${uuidPattern}$`, "i").test(clientId)) return false;
  return new RegExp(`^/objects/client-logos/${clientId}/${uuidPattern}\\.(png|jpg|webp)$`, "i").test(objectPath);
}

export async function getClientLogoFile(clientId: string, objectPath: string): Promise<File> {
  const match = objectPath.match(/^\/objects\/(client-logos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp))$/i);
  if (!match || !isClientLogoPath(clientId, objectPath)) throw new Error("Invalid client logo path.");
  const { bucketName, objectName } = splitBucketPath(`${privateObjectDir()}/${match[1]}`);
  return storage.bucket(bucketName).file(objectName);
}

export async function deleteClientLogoObject(clientId: string, objectPath: string) {
  const file = await getClientLogoFile(clientId, objectPath);
  await file.delete({ ignoreNotFound: true });
}

export async function deleteClientLogoIfUnreferenced(
  clientId: string,
  objectPath: string,
  hasReferences: (objectPath: string) => Promise<boolean>,
  deleteObject: (clientId: string, objectPath: string) => Promise<void> = deleteClientLogoObject,
) {
  if (!isClientLogoPath(clientId, objectPath)) return false;
  if (await hasReferences(objectPath)) return false;
  await deleteObject(clientId, objectPath);
  return true;
}

export async function cleanupClientLogoBestEffort(
  clientId: string,
  objectPath: string,
  hasReferences: (objectPath: string) => Promise<boolean>,
  reportFailure: () => void,
  deleteObject: (clientId: string, objectPath: string) => Promise<void> = deleteClientLogoObject,
) {
  try {
    return await deleteClientLogoIfUnreferenced(clientId, objectPath, hasReferences, deleteObject);
  } catch {
    reportFailure();
    return false;
  }
}

export async function assertClientLogoFile(clientId: string, objectPath: string) {
  const file = await getClientLogoFile(clientId, objectPath);
  const [metadata] = await file.getMetadata();
  const supported = Object.keys(extensions);
  if (!metadata.size || Number(metadata.size) > 2 * 1024 * 1024 ||
      !supported.includes(String(metadata.contentType))) {
    throw new Error("The uploaded file is not a supported logo image.");
  }
  return file;
}
